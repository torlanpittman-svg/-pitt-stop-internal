/**
 * Cloud print QUEUE operations. The bridge is a dumb, authenticated poller: it CLAIMS the next queued
 * job (atomic, skip-locked so multiple bridges never grab the same one), prints the PDF, then REPORTS
 * the outcome. Nothing here mutates QuickBooks.
 *
 * JOB LIFECYCLE — what each status actually proves:
 *   queued     waiting for the bridge (expires after PRINT_JOB_TTL_MINUTES — never prints late/unattended)
 *   claimed    handed to a bridge; outcome not reported yet (UNCERTAIN once it stays here too long)
 *   submitted  the bridge handed the PDF to the printer driver — NOT proof that paper came out
 *   stuck      a manager said no check came out, but the ORIGINAL may still be waiting in Windows or the
 *              printer (offline, out of paper, jam). Still ACTIVE: nothing new can be sent until someone
 *              confirms the original was cleared (or that it printed after all)
 *   printed    a manager CONFIRMED the paper check came out
 *   failed | expired | canceled   terminal; nothing (more) will print for this job
 *
 * DUPLICATE PREVENTION: a check may have at most ONE job in an active status (queued/claimed/submitted/stuck).
 * Enforced atomically here (guarded insert) and by the partial unique index
 * print_jobs_one_active_per_check (migration 0050). Every transition is a compare-and-set on the current
 * status, so a retried/late bridge report can never move a job twice.
 */
import { getDb } from '@/platform/db'
import { desc, eq, sql } from 'drizzle-orm'
import { printJobs, printBridges } from './schema'
import type { CheckPrintPayload } from './render'

export type PrintJobRow = typeof printJobs.$inferSelect
export type PrintBridgeRow = typeof printBridges.$inferSelect

export const ACTIVE_JOB_STATUSES = ['queued', 'claimed', 'submitted', 'stuck'] as const
/** Job kinds every bridge can print (the check paper path). A bridge is handed 'sticker'
 * jobs ONLY when it declares a configured label printer — an older bridge that doesn't
 * must never claim one, or it would print a label on the check printer. */
export const CHECK_JOB_KINDS = ['check', 'reprint', 'specimen'] as const
/** A queued job the bridge has not picked up within this window is expired instead of printing late. */
export const PRINT_JOB_TTL_MINUTES = 10
/** A claimed job with no report after this long is treated as an uncertain outcome (manager decides). */
export const CLAIM_UNCERTAIN_AFTER_SECONDS = 180
/** The bridge polls every few seconds; no poll for this long means it is offline. */
export const BRIDGE_ONLINE_WITHIN_SECONDS = 45

function rowsOf<T>(res: unknown): T[] {
  const list = (res as { rows?: T[] }).rows ?? (res as T[])
  return Array.isArray(list) ? list : []
}
/** Raw SQL returns snake_case columns; normalise to the drizzle row shape. */
function toJob(r: Record<string, unknown> | undefined | null): PrintJobRow | null {
  if (!r) return null
  if ('checkId' in r) return r as unknown as PrintJobRow
  const d = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)))
  return {
    id: r.id, checkId: r.check_id ?? null, kind: r.kind, status: r.status, printerTarget: r.printer_target ?? null,
    payload: r.payload, attempts: Number(r.attempts ?? 0), claimedBy: r.claimed_by ?? null, claimedAt: d(r.claimed_at),
    printedAt: d(r.printed_at), failedAt: d(r.failed_at), error: r.error ?? null, createdBy: r.created_by ?? null,
    createdAt: d(r.created_at), updatedAt: d(r.updated_at),
  } as PrintJobRow
}
const isUniqueViolation = (e: unknown) => String((e as { code?: string })?.code ?? '') === '23505' || /print_jobs_one_active_per_check|duplicate key/i.test(String((e as Error)?.message ?? ''))

/**
 * Enqueue a print job. For a real check (checkId set) the insert is refused — returning null — when that
 * check already has an active job, so a double-tap / second manager can never queue a second copy.
 */
export async function enqueuePrintJob(params: {
  checkId: string | null
  kind?: 'check' | 'reprint' | 'specimen'
  payload: CheckPrintPayload
  printerTarget?: string | null
  createdBy?: string | null
}): Promise<PrintJobRow | null> {
  const kind = params.kind ?? 'check'
  if (!params.checkId) {
    const [row] = await getDb().insert(printJobs).values({ checkId: null, kind, payload: params.payload, printerTarget: params.printerTarget ?? null, createdBy: params.createdBy ?? null }).returning()
    return row
  }
  try {
    const res = await getDb().execute(sql`
      INSERT INTO print_jobs (check_id, kind, payload, printer_target, created_by)
      SELECT ${params.checkId}::uuid, ${kind}, ${JSON.stringify(params.payload)}::jsonb, ${params.printerTarget ?? null}, ${params.createdBy ?? null}
       WHERE NOT EXISTS (
         SELECT 1 FROM print_jobs WHERE check_id = ${params.checkId}::uuid AND status IN ('queued', 'claimed', 'submitted', 'stuck')
       )
      RETURNING *
    `)
    return toJob(rowsOf<Record<string, unknown>>(res)[0])
  } catch (e) {
    if (isUniqueViolation(e)) return null // lost the race to a concurrent enqueue
    throw e
  }
}

/** Minutes during which a repeated specimen request returns the first one instead of printing another. */
export const SPECIMEN_COOLDOWN_MINUTES = 10
const SPECIMEN_SLOT_KEY = 'check_specimen_slot'

/** The most recent bank specimen job, if any. */
export async function latestSpecimenJob(): Promise<PrintJobRow | null> {
  const [row] = await getDb().select().from(printJobs).where(eq(printJobs.kind, 'specimen')).orderBy(desc(printJobs.createdAt)).limit(1)
  return row ?? null
}

/**
 * Atomically take the single "specimen slot". Exactly ONE caller wins per cooldown window, however many
 * requests arrive at once (double-click, retry, two devices): the upsert's conflict clause is evaluated
 * by Postgres against the latest committed row, so it cannot be raced the way a read-then-insert can.
 * The slot is one row in app_settings (existing table — no migration); it also records who last asked.
 */
export async function claimSpecimenSlot(actor: string | null): Promise<boolean> {
  const res = await getDb().execute(sql`
    INSERT INTO app_settings (key, value, type, category, label, updated_by)
    VALUES (${SPECIMEN_SLOT_KEY}, to_jsonb(now()::text), 'string', 'checks', 'Last bank specimen request', ${actor})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE app_settings.updated_at < now() - (${SPECIMEN_COOLDOWN_MINUTES} * interval '1 minute')
    RETURNING key
  `)
  return rowsOf<Record<string, unknown>>(res).length > 0
}

/** Give the slot back when nothing was queued after all (so a failed attempt does not block a retry). */
export async function releaseSpecimenSlot(): Promise<void> {
  await getDb().execute(sql`UPDATE app_settings SET updated_at = now() - interval '1 day' WHERE key = ${SPECIMEN_SLOT_KEY}`)
}

/** The active (queued/claimed/submitted/stuck) job for a check, if any. */
export async function activeJobForCheck(checkId: string): Promise<PrintJobRow | null> {
  const rows = await getDb().select().from(printJobs).where(eq(printJobs.checkId, checkId)).orderBy(desc(printJobs.createdAt))
  return rows.find((j) => (ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status)) ?? null
}

/**
 * Expire queued jobs older than the TTL so a check never prints unattended long after it was sent (e.g.
 * the bridge comes back hours later). Returns the expired jobs so the caller can reflect them on checks.
 *
 * `kinds` (optional) RESTRICTS the sweep to those job kinds; the default sweeps every kind, exactly as
 * before. It exists because expiring a job CONSUMES it (the UPDATE only matches status 'queued', so a
 * second sweep finds nothing): whoever expires a check job is the only one who can still reflect the
 * outcome on the check row. A caller that does not own check reconciliation — i.e. anything outside
 * apps/checks — must scope its sweep to its own kinds, or the check's 'print_failed' status and
 * 'print_expired' event would be silently lost. See reconcileExpiredJobs in ./service.ts.
 */
export async function expireStaleJobs(kinds?: readonly string[]): Promise<PrintJobRow[]> {
  if (kinds && kinds.length === 0) return []
  const kindFilter = kinds ? sql` AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``
  const res = await getDb().execute(sql`
    UPDATE print_jobs
       SET status = 'expired', failed_at = now(), updated_at = now(),
           error = ${`Not picked up by the shop printer within ${PRINT_JOB_TTL_MINUTES} minutes — expired without printing.`}
     WHERE status = 'queued' AND created_at < now() - interval '${sql.raw(String(PRINT_JOB_TTL_MINUTES))} minutes'${kindFilter}
    RETURNING *
  `)
  return rowsOf<Record<string, unknown>>(res).map((r) => toJob(r)!).filter(Boolean)
}

/**
 * Atomically claim the oldest queued, unexpired job OF A KIND THE BRIDGE SUPPORTS. Single statement
 * with FOR UPDATE SKIP LOCKED so concurrent bridges never double-print. Returns the claimed row or
 * null when the queue is empty. `kinds` defaults to the check-paper kinds, so a bridge that doesn't
 * declare a label printer is never handed a sticker job.
 */
export async function claimNextJob(bridgeId: string, kinds: readonly string[] = CHECK_JOB_KINDS): Promise<PrintJobRow | null> {
  if (kinds.length === 0) return null
  const res = await getDb().execute(sql`
    UPDATE print_jobs
       SET status = 'claimed', claimed_by = ${bridgeId}, claimed_at = now(),
           attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM print_jobs
        WHERE status = 'queued' AND created_at >= now() - interval '${sql.raw(String(PRINT_JOB_TTL_MINUTES))} minutes'
          AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING *
  `)
  return toJob(rowsOf<Record<string, unknown>>(res)[0])
}

export async function getJob(id: string): Promise<PrintJobRow | null> {
  const [row] = await getDb().select().from(printJobs).where(eq(printJobs.id, id)).limit(1)
  return row ?? null
}

/**
 * Compare-and-set a job's status: moves it to `to` ONLY if it is currently in one of `from`. Returns the
 * updated row, or null when the job was not in an allowed state (already moved — the caller no-ops).
 */
export async function transitionJob(id: string, from: readonly string[], to: 'submitted' | 'stuck' | 'printed' | 'failed' | 'canceled', error: string | null = null): Promise<PrintJobRow | null> {
  const res = await getDb().execute(sql`
    UPDATE print_jobs
       SET status = ${to}, updated_at = now(), error = ${error ? error.slice(0, 2000) : null},
           printed_at = ${to === 'printed' ? sql`now()` : sql`printed_at`},
           failed_at  = ${to === 'failed' || to === 'canceled' ? sql`now()` : sql`failed_at`}
     WHERE id = ${id}::uuid AND status IN (${sql.join(from.map((s) => sql`${s}`), sql`, `)})
    RETURNING *
  `)
  return toJob(rowsOf<Record<string, unknown>>(res)[0])
}

/** Attach a note to a still-claimed job (bridge could not determine the outcome) without moving it. */
export async function noteUncertainJob(id: string, note: string): Promise<void> {
  await getDb().execute(sql`UPDATE print_jobs SET error = ${note.slice(0, 2000)}, updated_at = now() WHERE id = ${id}::uuid AND status = 'claimed'`)
}

export async function jobsForCheck(checkId: string): Promise<PrintJobRow[]> {
  return getDb().select().from(printJobs).where(eq(printJobs.checkId, checkId)).orderBy(desc(printJobs.createdAt))
}

export async function queuedCount(): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)` }).from(printJobs).where(eq(printJobs.status, 'queued'))
  return Number(row?.n ?? 0)
}

/** True when a claimed job has gone unreported long enough that its outcome must be decided by a person. */
export function isUncertain(job: Pick<PrintJobRow, 'status' | 'claimedAt'>, now: Date = new Date()): boolean {
  return job.status === 'claimed' && !!job.claimedAt && now.getTime() - new Date(job.claimedAt).getTime() > CLAIM_UNCERTAIN_AFTER_SECONDS * 1000
}

// ── Bridge heartbeat ────────────────────────────────────────────────────────────────────────────────
export interface BridgeHello { bridgeId: string; version?: string | null; platform?: string | null; printer?: string | null; labelPrinter?: string | null; startedAt?: string | null }

/**
 * Record that a bridge polled. Throttled in SQL (at most one write per bridge every 15 s) so a 5-second
 * poll loop does not hammer the table. Best-effort: callers must never fail a claim because of this.
 */
export async function recordBridgeHeartbeat(h: BridgeHello): Promise<void> {
  const started = h.startedAt && !Number.isNaN(Date.parse(h.startedAt)) ? new Date(h.startedAt).toISOString() : null
  await getDb().execute(sql`
    INSERT INTO print_bridges (bridge_id, last_seen_at, started_at, version, platform, printer, label_printer)
    VALUES (${h.bridgeId}, now(), ${started}::timestamptz, ${h.version ?? null}, ${h.platform ?? null}, ${h.printer ?? null}, ${h.labelPrinter ?? null})
    ON CONFLICT (bridge_id) DO UPDATE
       SET last_seen_at = now(), started_at = COALESCE(EXCLUDED.started_at, print_bridges.started_at),
           version = EXCLUDED.version, platform = EXCLUDED.platform, printer = EXCLUDED.printer,
           label_printer = EXCLUDED.label_printer
     WHERE print_bridges.last_seen_at < now() - interval '15 seconds'
        OR print_bridges.started_at IS DISTINCT FROM COALESCE(EXCLUDED.started_at, print_bridges.started_at)
  `)
}

export interface BridgeStatus { online: boolean; bridges: { bridgeId: string; online: boolean; lastSeenAt: string; startedAt: string | null; version: string | null; platform: string | null; printer: string | null; labelPrinter: string | null }[] }

/** Which bridges have polled recently. `online` = at least one polled within BRIDGE_ONLINE_WITHIN_SECONDS. */
export async function getBridgeStatus(now: Date = new Date()): Promise<BridgeStatus> {
  const rows = await getDb().select().from(printBridges).orderBy(desc(printBridges.lastSeenAt)).limit(5)
  const bridges = rows.map((b) => ({
    bridgeId: b.bridgeId, online: now.getTime() - b.lastSeenAt.getTime() <= BRIDGE_ONLINE_WITHIN_SECONDS * 1000,
    lastSeenAt: b.lastSeenAt.toISOString(), startedAt: b.startedAt ? b.startedAt.toISOString() : null,
    version: b.version, platform: b.platform, printer: b.printer, labelPrinter: b.labelPrinter,
  }))
  return { online: bridges.some((b) => b.online), bridges }
}

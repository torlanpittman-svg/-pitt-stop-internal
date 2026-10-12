/**
 * Write-a-Check orchestration — the authoritative money-mutation path. Enforces the failure-state model:
 *
 *   RECORD (createAndRecordCheck):
 *     go-live gates (config + MICR + production QuickBooks company) → resolve payee (fail-closed) →
 *     reserve check number → persist intent → write QuickBooks Purchase/Check under an exclusive lock.
 *     • QB SUCCESS → status recorded; the check may now print.
 *     • QB FAILURE → status failed; NO negotiable check is printed; safe retry reuses the SAME row+number.
 *     • Idempotent: a replay with the same idempotencyKey returns the existing check and NEVER writes QB twice.
 *     • Concurrent retries: only the request holding the write lock talks to QuickBooks.
 *
 *   PRINT is a SEPARATE event, and "sent to the printer" is NOT "paper came out":
 *     queueCheckPrint  → at most ONE active job per check (no double print from a double tap)
 *     applyBridgeResult→ the bridge reports it SUBMITTED the job (or failed) — check becomes 'submitted'
 *     resolvePrintJob  → a MANAGER confirms the paper check came out ('printed'); "it did not" keeps the
 *                        job open until the original is cleared from Windows/the printer — only then
 *                        can it be sent again
 *     • a reprint is an explicit, separate action and never creates or alters a QuickBooks transaction.
 *
 * TEST PRINT creates no check row and no QB txn.
 */
import { createHash } from 'node:crypto'
import { getValidAccessToken } from '@/apps/quickbooks/connection'
import { getCheckConfig, bankForCategory, checkConfigReadiness, type CheckConfig } from './config'
import { categoryDef, categoryEntity, type CheckCategoryKey, type CheckView } from './types'
import { resolveVendor } from './vendor'
import { reserveNextNumber, releaseIfLast } from './numbering'
import { createCheckInQB, findChecksByDocNumber, decideRecovery } from './qb-check'
import {
  insertCheck, getCheckByIdempotencyKey, getCheckRow, markRecorded, markQbFailed, acquireQbWriteLock,
  setPrintStatus, logCheckEvent, toView, getCheckView,
} from './db'
import {
  enqueuePrintJob, claimSpecimenSlot, releaseSpecimenSlot, latestSpecimenJob, SPECIMEN_COOLDOWN_MINUTES, getJob, transitionJob, noteUncertainJob, activeJobForCheck, expireStaleJobs, isUncertain,
  CLAIM_UNCERTAIN_AFTER_SECONDS, type PrintJobRow,
} from './print-queue'
import { buildCheckPayload, buildFields, testValues, specimenValues, PAGE_WIDTH_IN, PAGE_HEIGHT_IN, type CheckPrintPayload } from './render'
import { assembleCheckTemplate, resolveDeferredMicr, resolveSpecimenMicr } from './template-server'
import { micrReadiness, specimenReadiness } from './micr'
import { renderCheckPdf } from './pdf'
import { businessDate } from './dates'
import type { BankKey } from './types'
import { logger } from '@/platform/logger'

const APP = 'checks:service'

export interface Actor { key: string | null; name: string | null }

export interface WriteCheckInput {
  payeeName: string
  vendorId?: string | null        // explicit pick from the picker (skips search)
  allowCreateVendor?: boolean      // manager confirmed "create new vendor"
  amountCents: number
  memo?: string | null
  category: CheckCategoryKey
  linkedJobId?: string | null
  linkedVehicleId?: string | null
  checkDate?: string | null        // defaults to today (US Central)
  idempotencyKey: string
}

export class CheckValidationError extends Error {
  constructor(message: string, public code: string) { super(message); this.name = 'CheckValidationError' }
}

function validate(input: WriteCheckInput): void {
  if (!input.payeeName?.trim()) throw new CheckValidationError('Payee is required.', 'payee_required')
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new CheckValidationError('Amount must be greater than $0.00.', 'amount_invalid')
  if (input.amountCents > 100_000_00) throw new CheckValidationError('Amount exceeds the $100,000 safety limit for a single check.', 'amount_too_large')
  if (!categoryDef(input.category)) throw new CheckValidationError('Unknown category.', 'category_invalid')
  if (!input.idempotencyKey?.trim()) throw new CheckValidationError('Missing idempotency key.', 'idempotency_required')
  if (input.checkDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.checkDate.trim())) throw new CheckValidationError('Check date must be YYYY-MM-DD.', 'date_invalid')
}

// ── Go-live gates ───────────────────────────────────────────────────────────────────────────────────

/** True when this stock needs us to print the MICR line (blank stock) and that is not fully ready. */
export function micrBlocksRealChecks(cfg: Pick<CheckConfig, 'templateMode' | 'micrEnabled'>): boolean {
  return cfg.templateMode !== 'preprinted' && !micrReadiness(cfg.micrEnabled).ready
}

/**
 * The QuickBooks company real checks are allowed to hit. Refuses unless the ACTIVE connection is the
 * PRODUCTION environment and is the exact company pinned at go-live — so a sandbox connection, or a
 * reconnect to a different company, can never receive (or silently swallow) a real check.
 * `CHECKS_ALLOW_SANDBOX_QB=1` lifts only the environment check, for local sandbox testing.
 */
export async function assertCheckRealm(cfg: Pick<CheckConfig, 'qboRealmId'>): Promise<string> {
  let token: { realmId: string; environment: string }
  try { token = await getValidAccessToken() } catch (e) {
    throw new CheckValidationError(`QuickBooks is not connected: ${String((e as Error)?.message ?? e)}`, 'qb_not_connected')
  }
  if (token.environment !== 'production' && process.env.CHECKS_ALLOW_SANDBOX_QB !== '1') {
    throw new CheckValidationError('Real checks can only be recorded in the production QuickBooks company (the active connection is not production).', 'qb_not_production')
  }
  if (!cfg.qboRealmId) throw new CheckValidationError('No QuickBooks company is pinned for checks yet — turn on live recording from setup to pin it.', 'realm_not_pinned')
  if (token.realmId !== cfg.qboRealmId) throw new CheckValidationError('The connected QuickBooks company is not the one approved for checks. Nothing was recorded.', 'realm_mismatch')
  return token.realmId
}

/**
 * Create + record a check. See failure-state model above. Returns the check view plus whether QB
 * recording succeeded so the caller only invokes printing after a real recording.
 */
export async function createAndRecordCheck(input: WriteCheckInput, actor: Actor): Promise<{ check: CheckView; recorded: boolean; error?: string }> {
  validate(input)

  // Idempotent replay — never double-write QuickBooks or reserve a second number.
  const existing = await getCheckByIdempotencyKey(input.idempotencyKey)
  if (existing) {
    const cfg = await getCheckConfig()
    return { check: toView(existing, cfg.banks[existing.bankKey as BankKey]?.label ?? existing.bankKey), recorded: existing.qbStatus === 'recorded', error: existing.qbError ?? undefined }
  }

  const cfg = await getCheckConfig()
  const readiness = checkConfigReadiness(cfg)
  if (!readiness.ready) throw new CheckValidationError('Check-writing is not configured yet (bank account not set). Complete setup first.', 'not_configured')
  // Fail-closed on REAL side effects: no QuickBooks Purchase and no check-number consumption until the
  // owner explicitly turns on live recording (going live). The whole workflow is still walkable/testable
  // (and a VOID/non-negotiable test print stays available) — this only blocks the final money mutation.
  if (!cfg.liveEnabled) throw new CheckValidationError('Live check recording is not enabled yet — hardware/MICR setup is pending. You can preview the full workflow and send a VOID test; recording a real check is disabled.', 'live_not_enabled')
  // A check we cannot print as a negotiable item must not be recorded as an expense or burn a number.
  if (micrBlocksRealChecks(cfg)) throw new CheckValidationError('The MICR line is not ready (bank numbers, font, or the MICR switch), so a negotiable check cannot be printed. Nothing was recorded.', 'micr_not_ready')

  const entity = categoryEntity(input.category)
  const bank = bankForCategory(cfg, input.category)
  if (!bank.qboAccountId) throw new CheckValidationError(`No bank account configured for ${entity === 'auto_sales' ? 'Auto Sales' : 'operating'} checks.`, 'bank_not_configured')
  const expenseAccountId = cfg.categoryAccounts[input.category]
  if (!expenseAccountId) throw new CheckValidationError(`No expense account mapped for "${categoryDef(input.category)?.label}". Finish setup.`, 'expense_not_configured')

  // BEFORE any QuickBooks call (vendor lookup/creation included): right environment, right company.
  const realmId = await assertCheckRealm(cfg)

  // Resolve payee BEFORE reserving a number so an ambiguity never burns a check number.
  const vendor = await resolveVendor(input.payeeName, { vendorId: input.vendorId ?? null, allowCreate: !!input.allowCreateVendor })

  const checkDate = input.checkDate?.trim() || businessDate()
  const checkNumber = await reserveNextNumber(bank.key as BankKey)

  // Persist durable intent BEFORE the QB write, with the number bound. If the process dies after QB but
  // before we mark recorded, the retry finds the Purchase by number and adopts it (no duplicate).
  let checkId: string
  try {
    checkId = await insertCheck({
      checkNumber, bankKey: bank.key as BankKey, bankQboAccountId: bank.qboAccountId,
      payeeName: vendor.displayName || input.payeeName.trim(), payeeQboVendorId: vendor.id,
      amountCents: input.amountCents, memo: input.memo?.trim() || null,
      category: input.category, expenseQboAccountId: expenseAccountId, entity,
      linkedJobId: input.linkedJobId ?? null, linkedVehicleId: input.linkedVehicleId ?? null,
      checkDate, idempotencyKey: input.idempotencyKey, actorKey: actor.key, actorName: actor.name,
    })
  } catch (e) {
    // Insert failed (e.g. a concurrent request already used this number/key) — release the number.
    await releaseIfLast(bank.key as BankKey, checkNumber).catch(() => {})
    const replay = await getCheckByIdempotencyKey(input.idempotencyKey)
    if (replay) { const c = await getCheckConfig(); return { check: toView(replay, c.banks[replay.bankKey as BankKey]?.label ?? replay.bankKey), recorded: replay.qbStatus === 'recorded', error: replay.qbError ?? undefined } }
    throw e
  }
  await logCheckEvent(checkId, 'created', actor.name, { checkNumber, amountCents: input.amountCents, payee: vendor.displayName, category: input.category, bank: bank.key })

  const recordResult = await attemptQbWrite(checkId, {
    bankAccountId: bank.qboAccountId, expenseAccountId, vendorId: vendor.id,
    amountCents: input.amountCents, docNumber: String(checkNumber), txnDate: checkDate,
    memo: input.memo?.trim() || null, lineDescription: input.memo?.trim() || null, realmId,
  }, actor)

  const view = (await getCheckView(checkId))!
  return { check: view, recorded: recordResult.recorded, error: recordResult.error }
}

interface QbWriteArgs {
  bankAccountId: string; expenseAccountId: string; vendorId: string
  amountCents: number; docNumber: string; txnDate: string
  memo: string | null; lineDescription: string | null; realmId: string | null
}

/** Stable QuickBooks `requestid` for a check's create call: same check + same content ⇒ same id, so a
 *  replay (timeout, crash, double request) is answered with the original Purchase, not a second one. */
export function qbRequestId(checkId: string, a: Pick<QbWriteArgs, 'bankAccountId' | 'expenseAccountId' | 'vendorId' | 'amountCents' | 'docNumber' | 'txnDate'>): string {
  return createHash('sha256').update([checkId, a.bankAccountId, a.expenseAccountId, a.vendorId, a.amountCents, a.docNumber, a.txnDate].join('|')).digest('hex').slice(0, 40)
}

/**
 * Perform (or safely re-perform) the QB write for an already-persisted check.
 *   1. Take the exclusive write lock — a concurrent caller backs off without touching QuickBooks.
 *   2. Look the check number up in QuickBooks: adopt ONLY an exact match (crash recovery); refuse on any
 *      other transaction with that number; otherwise create.
 */
async function attemptQbWrite(checkId: string, args: QbWriteArgs, actor: Actor): Promise<{ recorded: boolean; error?: string }> {
  const row = await getCheckRow(checkId)
  if (row?.qboTxnId) return { recorded: true } // already recorded — never write twice
  if (!(await acquireQbWriteLock(checkId))) {
    const now = await getCheckRow(checkId)
    if (now?.qboTxnId) return { recorded: true }
    return { recorded: false, error: 'QuickBooks recording for this check is already in progress. Wait a moment, then check again before retrying.' }
  }
  try {
    const decision = decideRecovery(await findChecksByDocNumber(args.docNumber), {
      bankAccountId: args.bankAccountId, vendorId: args.vendorId, amountCents: args.amountCents, txnDate: args.txnDate,
    })
    if (decision.action === 'conflict') {
      throw new Error(`Check #${args.docNumber} was NOT recorded: ${decision.reason}. Resolve it in QuickBooks before retrying.`)
    }
    const adopted = decision.action === 'adopt' ? decision.check : null
    const written = adopted ?? await createCheckInQB({
      bankAccountId: args.bankAccountId, expenseAccountId: args.expenseAccountId, vendorId: args.vendorId,
      amountCents: args.amountCents, docNumber: args.docNumber, txnDate: args.txnDate,
      memo: args.memo, lineDescription: args.lineDescription, requestId: qbRequestId(checkId, args),
    })
    await markRecorded(checkId, { txnId: written.purchaseId, docNumber: written.docNumber, syncToken: written.syncToken, realmId: args.realmId })
    await logCheckEvent(checkId, adopted ? 'recorded_adopted' : 'recorded', actor.name, { purchaseId: written.purchaseId, docNumber: written.docNumber })
    return { recorded: true }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    await markQbFailed(checkId, msg)   // also releases the write lock (status leaves 'writing')
    await logCheckEvent(checkId, 'qb_failed', actor.name, { error: msg })
    logger.error(APP, 'qb_write_failed', { checkId, error: msg })
    return { recorded: false, error: msg }
  }
}

/** Retry the QuickBooks write for a check that is not recorded yet (same row, same number, same account
 *  mapping it was created with; lock + adoption make it safe under concurrent retries). */
export async function retryQbWrite(checkId: string, actor: Actor): Promise<{ recorded: boolean; error?: string }> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qboTxnId) return { recorded: true }
  if (!row.payeeQboVendorId) throw new CheckValidationError('This check has no resolved payee — start a new check.', 'vendor_missing')
  const cfg = await getCheckConfig()
  if (!cfg.liveEnabled) throw new CheckValidationError('Live check recording is not enabled.', 'live_not_enabled')
  if (micrBlocksRealChecks(cfg)) throw new CheckValidationError('The MICR line is not ready, so this check cannot be printed as a negotiable item. Nothing was recorded.', 'micr_not_ready')
  const realmId = await assertCheckRealm(cfg)
  return attemptQbWrite(checkId, {
    bankAccountId: row.bankQboAccountId, expenseAccountId: row.expenseQboAccountId, vendorId: row.payeeQboVendorId,
    amountCents: row.amountCents, docNumber: String(row.checkNumber), txnDate: String(row.checkDate),
    memo: row.memo, lineDescription: row.memo, realmId,
  }, actor)
}

/**
 * Manually record the outcome of a print done on THIS device (browser print path — pre-printed stock
 * only). Refuses unless the check is recorded in QuickBooks, and while a shop-printer job is unresolved.
 */
export async function recordPrintResult(checkId: string, success: boolean, actor: Actor, opts: { reprint?: boolean } = {}): Promise<CheckView> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qbStatus !== 'recorded') throw new CheckValidationError('This check is not recorded in QuickBooks yet — resolve the accounting record before printing.', 'not_recorded')
  if (await activeJobForCheck(checkId)) throw new CheckValidationError('A shop-printer job for this check is still open — confirm or cancel it first.', 'print_in_progress')
  // On blank stock only the shop-printer PDF carries the MICR line; a browser printout is not a
  // negotiable check and must never be recorded as the printed check.
  if (success && (await getCheckConfig()).templateMode !== 'preprinted') {
    throw new CheckValidationError('A check printed from this device has no MICR line and is not negotiable. Send it to the shop printer instead.', 'browser_print_not_negotiable')
  }
  return applyPrintOutcome(checkId, success, actor.name, { reprint: !!opts.reprint })
}

async function applyPrintOutcome(checkId: string, success: boolean, actorName: string | null, opts: { reprint: boolean; jobId?: string }): Promise<CheckView> {
  const before = await getCheckRow(checkId)
  // A failed REPRINT never downgrades a check whose original print was already confirmed.
  const status = success ? 'printed' : (before?.printStatus === 'printed' ? 'printed' : 'print_failed')
  const updated = await setPrintStatus(checkId, status, { bumpReprint: opts.reprint && success })
  await logCheckEvent(checkId, opts.reprint ? (success ? 'reprinted' : 'reprint_failed') : (success ? 'printed' : 'print_failed'), actorName, { reprintCount: updated?.reprintCount, jobId: opts.jobId })
  const cfg = await getCheckConfig()
  return toView(updated!, cfg.banks[updated!.bankKey as BankKey]?.label ?? updated!.bankKey)
}

/**
 * Enqueue a check onto the cloud print queue for the always-on Pitt Stop print bridge (production path;
 * the manager's phone never talks to the printer directly).
 *   • requires a QuickBooks-recorded check and a ready MICR line (never queues a non-negotiable "check");
 *   • refuses while the check already has an open job (queued / at the printer / awaiting confirmation);
 *   • refuses a second ORIGINAL once a print is confirmed — another copy must be an explicit `reprint`.
 * Never creates or alters any QuickBooks transaction.
 */
export async function queueCheckPrint(checkId: string, actor: Actor, opts: { reprint?: boolean } = {}): Promise<{ jobId: string }> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qbStatus !== 'recorded') throw new CheckValidationError('This check is not recorded in QuickBooks yet — resolve the accounting record before printing.', 'not_recorded')
  const cfg = await getCheckConfig()
  if (micrBlocksRealChecks(cfg)) throw new CheckValidationError('The MICR line is not ready, so this check cannot be printed as a negotiable item.', 'micr_not_ready')
  await reconcileExpiredJobs()
  const inProgress = new CheckValidationError('This check already has a print that is not resolved. Settle the original (printed, or cleared from the printer) before sending it again.', 'print_in_progress')
  if (await activeJobForCheck(checkId)) throw inProgress
  const alreadyPrinted = row.printStatus === 'printed'
  if (alreadyPrinted && !opts.reprint) throw new CheckValidationError('This check has already been printed. Use Reprint only if the original was destroyed or never came out.', 'already_printed')
  const kind = alreadyPrinted ? 'reprint' : 'check'

  const view = (await getCheckView(checkId))!
  const template = assembleCheckTemplate(cfg, cfg.layout, { test: false, checkNumber: view.checkNumber })
  const payload = buildCheckPayload(view, cfg.layout, template)
  const job = await enqueuePrintJob({ checkId, kind, payload, createdBy: actor.name })
  if (!job) throw inProgress // lost the race to a concurrent request
  await logCheckEvent(checkId, kind === 'reprint' ? 'reprint_queued' : 'print_queued', actor.name, { jobId: job.id })
  return { jobId: job.id }
}

/**
 * Enqueue a NON-NEGOTIABLE VOID test page to the shop printer via the queue — proves the full
 * phone → cloud → bridge → Brother path and is the calibration tool. Creates NO check record and NO
 * QuickBooks transaction; the page carries a VOID watermark and, at most, the all-zero test MICR line.
 */
export async function enqueueTestPrint(actor: Actor): Promise<{ jobId: string }> {
  const cfg = await getCheckConfig()
  const template = assembleCheckTemplate(cfg, cfg.layout, { test: true })
  const fields = buildFields(testValues(), cfg.layout)
  const payload: CheckPrintPayload = {
    pageWidthIn: PAGE_WIDTH_IN, pageHeightIn: PAGE_HEIGHT_IN, fields, template,
    watermark: 'VOID - TEST - NOT NEGOTIABLE',
  }
  const job = await enqueuePrintJob({ checkId: null, kind: 'check', payload, createdBy: actor.name })
  return { jobId: job!.id }
}

/**
 * Enqueue a NON-NEGOTIABLE BANK SPECIMEN: the real routing/account MICR line (check number 000000) on a
 * page that says VOID across its face and over the signature line, with the MICR clear band left free —
 * something the bank can run through its reader. Creates NO check record and NO QuickBooks transaction,
 * and takes NO check number. Works with micr_enabled OFF (that switch gates negotiable checks only), but
 * needs valid bank numbers + the font. The bank numbers are not stored: the line is built at claim time.
 * EXACTLY ONE per request burst: an atomic slot (claimSpecimenSlot) lets one caller through per cooldown
 * window; any retry, double-click or second device inside it gets the first job back, never a second page.
 */
export async function enqueueBankSpecimen(actor: Actor): Promise<{ jobId: string; alreadyQueued: boolean }> {
  const cfg = await getCheckConfig()
  if (cfg.templateMode !== 'blank_full') throw new CheckValidationError('A bank specimen only applies to blank check stock.', 'specimen_not_applicable')
  if (!specimenReadiness().ready) throw new CheckValidationError('The bank numbers or the MICR font are not ready, so a specimen cannot be printed. Nothing was sent.', 'micr_not_ready')
  if (!(await claimSpecimenSlot(actor.name))) {
    const recent = await latestSpecimenJob()
    if (recent && Date.now() - new Date(recent.createdAt).getTime() < SPECIMEN_COOLDOWN_MINUTES * 60_000) return { jobId: recent.id, alreadyQueued: true }
    throw new CheckValidationError(`A specimen was requested less than ${SPECIMEN_COOLDOWN_MINUTES} minutes ago. Nothing new was sent.`, 'specimen_cooldown')
  }
  try {
    const template = assembleCheckTemplate(cfg, cfg.layout, { test: false, specimen: true })
    const payload: CheckPrintPayload = { pageWidthIn: PAGE_WIDTH_IN, pageHeightIn: PAGE_HEIGHT_IN, fields: buildFields(specimenValues(), cfg.layout), template }
    const job = await enqueuePrintJob({ checkId: null, kind: 'specimen', payload, createdBy: actor.name })
    logger.info('checks', 'specimen.queued', { jobId: job!.id, by: actor.name })
    return { jobId: job!.id, alreadyQueued: false }
  } catch (e) {
    await releaseSpecimenSlot().catch(() => {})
    throw e
  }
}

/** Expire stale queued jobs and reflect each onto its check (so it can be re-sent deliberately). */
export async function reconcileExpiredJobs(): Promise<number> {
  const expired = await expireStaleJobs()
  for (const job of expired) {
    if (!job.checkId) continue
    const row = await getCheckRow(job.checkId)
    if (row && row.printStatus !== 'printed') await setPrintStatus(job.checkId, 'print_failed')
    await logCheckEvent(job.checkId, 'print_expired', 'system', { jobId: job.id })
  }
  return expired.length
}

/**
 * Turn a just-claimed job into the PDF the bridge will print — or refuse. A REAL check is re-validated at
 * this last moment: it must still be recorded in QuickBooks and its MICR line must resolve to real E-13B.
 * If not, the job is FAILED and nothing is sent: a real check never prints with a placeholder MICR line.
 */
export async function renderClaimedJob(job: PrintJobRow): Promise<{ pdf: Buffer } | { refused: string }> {
  const refuse = async (reason: string) => {
    await transitionJob(job.id, ['claimed'], 'failed', reason)
    if (job.checkId) {
      const row = await getCheckRow(job.checkId)
      if (row && row.printStatus !== 'printed') await setPrintStatus(job.checkId, 'print_failed')
      await logCheckEvent(job.checkId, 'print_refused', 'system', { jobId: job.id, reason })
    }
    return { refused: reason }
  }
  try {
    const payload = job.payload as unknown as CheckPrintPayload
    if (job.checkId) {
      const row = await getCheckRow(job.checkId)
      if (!row || row.qbStatus !== 'recorded') return refuse('check is not recorded in QuickBooks')
      // SECRET-SAFETY: the real routing/account MICR line is built HERE (server-only env), never stored.
      const cfg = await getCheckConfig()
      if (cfg.templateMode !== 'preprinted') {
        const resolved = resolveDeferredMicr(payload.template ?? null, cfg)
        if (resolved?.micr?.mode !== 'e13b' || !resolved.micr.cells?.length) return refuse('MICR line is not ready — refusing to print a non-negotiable check')
        payload.template = resolved
      }
      // A real check never carries a watermark; a test page never reaches this branch.
      return { pdf: renderCheckPdf(payload) }
    }
    if (job.kind === 'specimen' || payload.template?.micr?.deferSpecimen) {
      // BANK SPECIMEN: the real line is built HERE and only here. It prints only as a marked VOID page.
      const resolved = resolveSpecimenMicr(payload.template ?? null)
      if (resolved?.micr?.mode !== 'e13b' || !resolved.micr.cells?.length) return refuse('bank numbers or MICR font not ready — specimen not printed')
      if (!resolved.texts.some((t) => /\bVOID\b/.test(t.value))) return refuse('specimen is missing its VOID markings — not printed')
      payload.template = resolved
      return { pdf: renderCheckPdf(payload) }
    }
    return { pdf: renderCheckPdf(payload, payload.watermark ? { watermark: payload.watermark } : {}) }
  } catch (e) {
    return refuse(`render_failed: ${String((e as Error)?.message ?? e)}`)
  }
}

export type BridgeOutcome = 'submitted' | 'failed' | 'uncertain'

/**
 * Apply a print bridge's report for a claimed job. Compare-and-set on the job status, so a duplicate or
 * late report is a harmless no-op (never double-counts a reprint, never revives a finished job).
 *   submitted → the driver accepted the job. The check becomes 'submitted' — awaiting a manager's
 *               confirmation that paper came out. This is NOT recorded as printed.
 *   failed    → the bridge is sure nothing will print; the check can be re-sent.
 *   uncertain → the bridge could not tell; the job stays open for a manager to resolve.
 * Never touches QuickBooks.
 */
export async function applyBridgeResult(jobId: string, outcome: BridgeOutcome, error: string | null): Promise<{ ok: true; applied: boolean }> {
  const job = await getJob(jobId)
  if (!job) throw new CheckValidationError('Print job not found.', 'job_not_found')
  if (outcome === 'uncertain') {
    await noteUncertainJob(jobId, error ?? 'bridge could not determine whether the job printed')
    if (job.checkId && job.status === 'claimed') await logCheckEvent(job.checkId, 'print_uncertain', 'print-bridge', { jobId, error })
    return { ok: true, applied: job.status === 'claimed' }
  }
  const moved = await transitionJob(jobId, ['claimed'], outcome === 'submitted' ? 'submitted' : 'failed', outcome === 'failed' ? (error ?? 'print failed') : null)
  if (!moved) return { ok: true, applied: false } // already reported/resolved
  if (job.checkId) {
    const row = await getCheckRow(job.checkId)
    if (row && row.qbStatus === 'recorded') {
      if (outcome === 'submitted') {
        if (row.printStatus !== 'printed') await setPrintStatus(job.checkId, 'submitted')
        await logCheckEvent(job.checkId, 'print_submitted', 'print-bridge', { jobId })
      } else {
        await applyPrintOutcome(job.checkId, false, 'print-bridge', { reprint: job.kind === 'reprint', jobId })
      }
    }
  }
  return { ok: true, applied: true }
}

export type ManagerPrintOutcome = 'printed' | 'not_printed' | 'cleared' | 'cancel'

/**
 * A manager settles a print job by looking at the printer:
 *   printed      the paper check came out (job submitted / silent too long / previously reported stuck)
 *   not_printed  no check came out. This does NOT free the check for another send: the original may still
 *                be waiting in Windows or in the printer and would print later. The job becomes 'stuck'
 *                (still active) until it is resolved with 'cleared' or 'printed'.
 *   cleared      the original was removed (Windows print queue emptied + printer power-cycled), so it can
 *                no longer print. Only now may the check be sent again.
 *   cancel       withdraw a job still waiting in the cloud queue (the bridge never took it)
 * Compare-and-set, so two managers answering at once cannot both apply.
 */
export async function resolvePrintJob(checkId: string, jobId: string, outcome: ManagerPrintOutcome, actor: Actor): Promise<CheckView> {
  const job = await getJob(jobId)
  if (!job || job.checkId !== checkId) throw new CheckValidationError('Print job not found for this check.', 'job_not_found')
  const stale = new CheckValidationError('That print job was already resolved. Refresh to see its current state.', 'job_already_resolved')
  const who = actor.name ?? 'manager'
  if (outcome === 'cancel') {
    if (!(await transitionJob(jobId, ['queued'], 'canceled', `canceled by ${who} before printing`))) throw stale
    const row = await getCheckRow(checkId)
    if (row && row.printStatus !== 'printed') await setPrintStatus(checkId, 'not_printed')
    await logCheckEvent(checkId, 'print_canceled', actor.name, { jobId })
    return (await getCheckView(checkId))!
  }
  if (outcome === 'cleared') {
    // Only a job already reported as not printed can be cleared — it is a second, deliberate step.
    if (!(await transitionJob(jobId, ['stuck'], 'failed', `${who} reported no check came out, then confirmed the original was cleared from Windows and the printer`))) throw stale
    await logCheckEvent(checkId, 'print_original_cleared', actor.name, { jobId })
    return applyPrintOutcome(checkId, false, actor.name, { reprint: job.kind === 'reprint', jobId })
  }
  if (job.status === 'claimed' && !isUncertain(job)) {
    throw new CheckValidationError(`The printer is still working on this job. If nothing has printed after ${Math.round(CLAIM_UNCERTAIN_AFTER_SECONDS / 60)} minutes you can settle it here.`, 'print_in_progress')
  }
  if (outcome === 'printed') {
    if (!(await transitionJob(jobId, ['submitted', 'claimed', 'stuck'], 'printed'))) throw stale
    await logCheckEvent(checkId, 'print_confirmed', actor.name, { jobId })
    return applyPrintOutcome(checkId, true, actor.name, { reprint: job.kind === 'reprint', jobId })
  }
  // not_printed: hold the job open. The check's print status is left as it is (awaiting an answer).
  if (!(await transitionJob(jobId, ['submitted', 'claimed'], 'stuck', `${who} reported that no check came out — the original must be cleared before sending again`))) throw stale
  await logCheckEvent(checkId, 'print_not_confirmed', actor.name, { jobId })
  return (await getCheckView(checkId))!
}

/** Guard for the browser print page: a check may be (re)printed only once it is recorded in QB. */
export async function assertPrintable(checkId: string): Promise<void> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qbStatus !== 'recorded') throw new CheckValidationError('Check is not recorded in QuickBooks yet.', 'not_recorded')
}

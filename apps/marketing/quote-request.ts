/**
 * Public quote requests (ceramic coating / headliner / other) from /quote.
 *
 * One path, no new infrastructure:
 *   validate → ONE data-modifying-CTE statement creates the quote_requests claim (UNIQUE request_key),
 *   its marketing_leads row AND the lead_created audit event all-or-nothing (the neon-http driver has no
 *   transactions, so atomicity lives in the single statement) → email to the shop's quote inbox through
 *   the SAME Postmark transactional provider the booking notices use (apps/appointments/notify.ts), with
 *   Reply-To = the customer's address → the send outcome is recorded on the claim row, so a replay
 *   returns the truth instead of sending again.
 *
 * Idempotency (same rules as the appointment outbox):
 *   - the UNIQUE request_key makes exactly one invocation the owner, even across concurrent connections,
 *     and the claim cannot exist without its lead (atomic statement + NOT NULL lead_id) — no recovery
 *     path ever has to guess whether a lead was created;
 *   - every provider send is authorized by WINNING the email_attempts fence (a conditional UPDATE), so a
 *     delayed owner that loses the fence can never send — there is no unfenced takeover;
 *   - a replay of a 'sent' or 'uncertain' request NEVER re-sends (an accepted email can't go out twice);
 *   - a replay of 'failed' / 'not_configured' / 'blocked' re-fences atomically and tries the send again;
 *   - a reused key with a DIFFERENT payload is a conflict, never another payload's stored result;
 *   - photos are persisted on the claim row, so a failed send does not destroy them.
 *
 * Click attribution (gclid / utm_*) is recorded against the lead in marketing_attribution; the customer's
 * own words never touch it. The optional "How did you hear about us?" answer is stored on the lead row
 * (referral_source / referral_detail) as what the customer SAID — reported beside, never merged with, attribution.
 */
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { recordAttribution } from './attribution'
import { quoteRequests } from './schema'
import { cleanAttribution, classifySource, attributionConfidence, type BookingAttribution } from '@/apps/appointments/attribution'
import { isValidUsPhone, isValidEmail, formatUsPhone } from '@/apps/appointments/contact'
import { transactionalEmailProvider, UNCERTAIN_NOTE, type TransactionalEmailProvider, type EmailAttachment, type DeliveryResult } from '@/apps/appointments/notify'
import { normalizeReferralSource, referralSourceLabel } from '@/apps/quick-entry/referral-source'

import { QUOTE_SERVICES, MAX_PHOTOS, MAX_PHOTO_BYTES, type QuoteService, type QuotePhoto, type QuoteRequest, type QuoteErrors } from './quote-shared'
export { QUOTE_SERVICES, MAX_PHOTOS, MAX_PHOTO_BYTES, type QuoteService, type QuotePhoto, type QuoteRequest, type QuoteErrors } from './quote-shared'

/** Where quote requests are delivered. Override with QUOTE_INBOX; the default is the monitored shop group. */
export const DEFAULT_QUOTE_INBOX = 'service@pittstopbcs.com'
export const quoteInbox = (env: NodeJS.ProcessEnv = process.env): string => (env.QUOTE_INBOX ?? '').trim() || DEFAULT_QUOTE_INBOX

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Normalises + validates an untrusted body. Returns the clean request or field errors — never both. */
export function parseQuoteRequest(body: unknown): { ok: true; req: QuoteRequest } | { ok: false; errors: QuoteErrors } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const errors: QuoteErrors = {}
  const service = str(b.service, 20) as QuoteService
  // Object.hasOwn, not `in`: inherited keys ('toString', '__proto__', …) must not pass as services.
  if (!Object.hasOwn(QUOTE_SERVICES, service)) errors.service = 'Choose a service.'
  const name = str(b.name, 80)
  if (name.length < 2) errors.name = 'Enter your name.'
  const phone = str(b.phone, 40)
  if (!isValidUsPhone(phone)) errors.phone = 'Enter a 10-digit phone number.'
  const email = str(b.email, 240).toLowerCase()
  if (!isValidEmail(email)) errors.email = 'Enter a valid email so we can send your quote.'
  const vehicleYear = str(b.vehicleYear, 4)
  if (!/^(19|20)\d\d$/.test(vehicleYear)) errors.vehicleYear = 'Enter the vehicle year.'
  const vehicleMake = str(b.vehicleMake, 40)
  if (!vehicleMake) errors.vehicleMake = 'Enter the make.'
  const vehicleModel = str(b.vehicleModel, 40)
  if (!vehicleModel) errors.vehicleModel = 'Enter the model.'
  const message = str(b.message, 1500)
  const referralSource = normalizeReferralSource(b.referralSource)
  const referralDetail = referralSource ? str(b.referralDetail, 120) : ''
  const rawPhotos = Array.isArray(b.photos) ? b.photos : []
  if (rawPhotos.length > MAX_PHOTOS) errors.photos = `Up to ${MAX_PHOTOS} photos.`
  const photos: QuotePhoto[] = []
  for (const p of rawPhotos.slice(0, MAX_PHOTOS)) {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    const contentType = str(o.contentType, 20)
    const contentBase64 = typeof o.contentBase64 === 'string' ? o.contentBase64.replace(/\s+/g, '') : ''
    if (!PHOTO_TYPES.has(contentType) || !/^[A-Za-z0-9+/=]+$/.test(contentBase64)) { errors.photos = 'Photos must be JPEG, PNG or WebP.'; continue }
    if (contentBase64.length * 0.75 > MAX_PHOTO_BYTES) { errors.photos = 'Each photo must be under about 1 MB.'; continue }
    photos.push({ name: str(o.name, 80).replace(/[^\w.-]+/g, '_') || `photo-${photos.length + 1}.jpg`, contentType, contentBase64 })
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, req: { service, name, phone: formatUsPhone(phone), email, vehicleYear, vehicleMake, vehicleModel, message, photos, referralSource, referralDetail } }
}

export const vehicleLabel = (r: Pick<QuoteRequest, 'vehicleYear' | 'vehicleMake' | 'vehicleModel'>) => [r.vehicleYear, r.vehicleMake, r.vehicleModel].filter(Boolean).join(' ')

/** "Ceramic coating quote request — 2020 Cadillac XT6 — Jane Doe" */
export function quoteSubject(r: QuoteRequest): string {
  return `${QUOTE_SERVICES[r.service].label} quote request — ${vehicleLabel(r)} — ${r.name}`
}

export function quoteEmailText(r: QuoteRequest, meta: { leadId: string; source: string; receivedAt: Date }): string {
  const lines = [
    `New quote request from the website (${QUOTE_SERVICES[r.service].label}).`,
    '',
    `Name:     ${r.name}`,
    `Phone:    ${r.phone}`,
    `Email:    ${r.email}   (reply to this email to answer the customer)`,
    `Vehicle:  ${vehicleLabel(r)}`,
    `Service:  ${QUOTE_SERVICES[r.service].label}`,
    '',
    'Customer notes:',
    r.message || '(none)',
    '',
    `Heard about us (customer's own answer): ${r.referralSource ? referralSourceLabel(r.referralSource) + (r.referralDetail ? ` — ${r.referralDetail}` : '') : '(not answered)'}`,
    '',
    r.photos.length ? `${r.photos.length} photo(s) attached.` : 'No photos attached.',
    '',
    `Received ${meta.receivedAt.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT · source: ${meta.source} · lead ${meta.leadId}`,
  ]
  return lines.join('\n')
}

export type QuoteEmailStatus = 'sent' | 'failed' | 'not_configured' | 'uncertain' | 'blocked'
export interface SubmitResult { leadId: string; emailed: QuoteEmailStatus; inbox: string; error?: string | null; replayed: boolean }

/** A request key was reused with different content — the caller must NOT receive the stored result. */
export class QuoteRequestConflictError extends Error {
  constructor() { super('This request key was already used for a different request.'); this.name = 'QuoteRequestConflictError' }
}
/** Another invocation owns this request and has not finished; nothing here claims the lead was lost. */
export class QuoteStillProcessingError extends Error {
  constructor() { super('This quote request is still being processed by an earlier attempt.'); this.name = 'QuoteStillProcessingError' }
}

/** Client-generated opaque token (crypto.randomUUID or the fallback in QuoteForm). Anything else is ignored. */
const REQUEST_KEY_RE = /^[A-Za-z0-9-]{16,64}$/
export const normalizeRequestKey = (v: unknown): string | null =>
  typeof v === 'string' && REQUEST_KEY_RE.test(v.trim()) ? v.trim() : null

/** Content fingerprint: a reused key with a different payload must conflict, never replay. Photos included. */
export function quotePayloadHash(req: QuoteRequest): string {
  return createHash('sha256').update(JSON.stringify([
    req.service, req.name, req.phone, req.email, req.vehicleYear, req.vehicleMake, req.vehicleModel,
    req.message, req.referralSource, req.referralDetail, req.photos.map((p) => [p.name, p.contentType, p.contentBase64]),
  ])).digest('hex')
}

/** Statuses a replay may re-attempt: the provider definitely did NOT accept the email (same set requeueNotification allows). */
const RETRYABLE_EMAIL_STATUSES = ['failed', 'not_configured', 'blocked'] as const

export interface SubmitDeps {
  provider?: TransactionalEmailProvider
  now?: Date
  env?: NodeJS.ProcessEnv
  /** Client request key; missing/invalid → a server-generated key (no cross-retry protection, same path). */
  requestKey?: string | null
  /** Replay tuning, for tests: poll cadence while another invocation works, and the stale-claim takeover age. */
  replay?: { pollMs?: number; polls?: number; staleMs?: number }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rowsOf<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] })?.rows ?? [])
}

export async function submitQuoteRequest(req: QuoteRequest, rawAttribution: unknown, deps: SubmitDeps = {}): Promise<SubmitResult> {
  const key = normalizeRequestKey(deps.requestKey) ?? randomUUID()
  const hash = quotePayloadHash(req)
  const now = deps.now ?? new Date()
  const attribution: BookingAttribution = cleanAttribution(rawAttribution)
  const source = classifySource(attribution)
  // THE claim — ONE atomic statement (data-modifying CTEs): the quote_requests row, its marketing_leads
  // row and the append-only lead_created audit event commit or vanish together, so a crash or a failure
  // in any of the three leaves NOTHING behind (no orphaned lead, no lead-less claim — lead_id is NOT NULL).
  // ON CONFLICT on the unique request_key makes exactly one invocation the owner across concurrent
  // connections; on conflict every CTE is a no-op and we take the replay path. FK checks run at statement
  // end, so the claim may reference the lead created in the next CTE. IDs are generated here so the lead
  // note can name the claim row. Photos are persisted BEFORE any email attempt.
  const rowId = randomUUID()
  const leadId = randomUUID()
  const notes = [`Quote request via /quote`, req.message ? `Customer notes: ${req.message}` : null,
    req.photos.length ? `${req.photos.length} photo(s) saved with quote request ${rowId}` : null].filter(Boolean).join('\n')
  const res = await getDb().execute(sql`
    WITH claim AS (
      INSERT INTO quote_requests (id, request_key, payload_hash, lead_id, photos)
      VALUES (${rowId}::uuid, ${key}, ${hash}, ${leadId}::uuid, ${JSON.stringify(req.photos)}::jsonb)
      ON CONFLICT (request_key) DO NOTHING
      RETURNING id
    ), lead AS (
      INSERT INTO marketing_leads (id, name, phone, email, vehicle, requested_service, source, status, referral_source, referral_detail, notes)
      SELECT ${leadId}::uuid, ${req.name}, ${req.phone}, ${req.email}, ${vehicleLabel(req)}, ${QUOTE_SERVICES[req.service].category},
             ${source}, 'new', ${req.referralSource}, ${req.referralDetail || null}, ${notes}
      FROM claim
      RETURNING id
    ), audit AS (
      INSERT INTO marketing_events (event_type, entity_type, entity_id, actor, meta)
      SELECT 'lead_created', 'lead', lead.id, ${'website:quote'}, ${JSON.stringify({ source })}::jsonb
      FROM lead
      RETURNING id
    )
    SELECT claim.id AS claimed_id FROM claim
  `)
  if (rowsOf<{ claimed_id: string }>(res).length === 0) return replayRequest(key, hash, req, rawAttribution, deps)

  if (attribution.gclid || attribution.utm_source || attribution.fbclid) {
    await recordAttribution({
      source, medium: attribution.utm_medium ?? null, campaign: attribution.utm_campaign ?? null,
      utmSource: attribution.utm_source ?? null, utmMedium: attribution.utm_medium ?? null, utmCampaign: attribution.utm_campaign ?? null,
      clickId: attribution.gclid ?? attribution.fbclid ?? null, confidence: attributionConfidence(attribution), leadId, occurredAt: now,
    }, 'website:quote').catch(() => undefined) // attribution is a bonus — never blocks the request
  }
  // Even the creator must WIN the fence to send. If a crash-recovery replayer fenced first (possible only
  // if this invocation stalled long enough to look dead), losing here means someone else owns the send —
  // follow their outcome instead of ever producing a second email.
  const token = await fenceSend(getDb(), rowId, { firstSend: true })
  if (token === null) return replayRequest(key, hash, req, rawAttribution, deps)
  const { emailed, error } = await sendWithToken(rowId, token, leadId, req, source, deps, now)
  return { leadId, emailed, inbox: quoteInbox(deps.env ?? process.env), error, replayed: false }
}

/**
 * The send fence: a send happens ONLY after winning this conditional UPDATE, which moves email_attempts
 * forward. First send: 0 → 1 while 'processing'. Retry: +1, only from a recorded DEFINITE non-delivery.
 * 'processing' (in flight) and 'uncertain'/'sent' can never be fenced, so an unresolved or possibly
 * delivered email can never be sent again — including by a delayed owner, whose own fence then loses.
 */
async function fenceSend(db: ReturnType<typeof getDb>, rowId: string, opts: { firstSend?: boolean; staleBefore?: Date }): Promise<number | null> {
  const conditions = [eq(quoteRequests.id, rowId)]
  if (opts.firstSend) conditions.push(eq(quoteRequests.emailStatus, 'processing'), eq(quoteRequests.emailAttempts, 0))
  else conditions.push(inArray(quoteRequests.emailStatus, [...RETRYABLE_EMAIL_STATUSES]))
  if (opts.staleBefore) conditions.push(lt(quoteRequests.updatedAt, opts.staleBefore))
  const [won] = await db.update(quoteRequests)
    .set({ emailStatus: 'processing', emailAttempts: sql`${quoteRequests.emailAttempts} + 1`, updatedAt: new Date() })
    .where(and(...conditions)).returning()
  return won ? won.emailAttempts : null
}

/** One fenced send attempt. NEVER throws: the lead already exists, so every exit is an honest outcome. */
async function sendWithToken(rowId: string, token: number, leadId: string, req: QuoteRequest, source: string, deps: SubmitDeps, now: Date): Promise<{ emailed: QuoteEmailStatus; error: string | null }> {
  const provider = deps.provider ?? transactionalEmailProvider(deps.env ?? process.env)
  const inbox = quoteInbox(deps.env ?? process.env)
  const attachments: EmailAttachment[] = req.photos.map((p) => ({ name: p.name, contentType: p.contentType, contentBase64: p.contentBase64 }))
  let result: DeliveryResult
  try {
    result = await provider.send({ to: inbox, subject: quoteSubject(req), text: quoteEmailText(req, { leadId, source, receivedAt: now }), replyTo: req.email, attachments })
  } catch (e) {
    // The provider contract never throws, so a throw gives no delivery evidence either way. Same rule as
    // the appointment outbox: what MIGHT have been accepted is 'uncertain' and is never resent automatically.
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    result = { status: 'uncertain', error: `${UNCERTAIN_NOTE} (${why})`.slice(0, 500) }
  }
  const emailed: QuoteEmailStatus = result.status
  const error = result.status === 'failed' || result.status === 'uncertain' ? result.error : result.status === 'blocked' ? result.reason : null
  try {
    // Record only onto our own fenced attempt. 'uncertain' is included so a definite outcome known to THIS
    // sender upgrades a stale-marker set by a watching replayer — strictly more accurate, never a resend
    // risk ('sent' is terminal; 'failed' is a proven non-delivery of this same attempt).
    await getDb().update(quoteRequests)
      .set({ emailStatus: emailed, emailError: error, updatedAt: new Date() })
      .where(and(eq(quoteRequests.id, rowId), eq(quoteRequests.emailAttempts, token), inArray(quoteRequests.emailStatus, ['processing', 'uncertain'])))
  } catch (e) {
    // The send already happened — this must not surface as "nothing was saved". The row stays 'processing'
    // at this token; nothing can fence that state, so the worst a replay can do is mark it 'uncertain'.
    // Never a resend, and the caller still gets the true provider outcome.
    const why = e instanceof Error ? e.message : String(e)
    return { emailed, error: `${error ? `${error} ` : ''}(Recording the outcome failed: ${why.slice(0, 200)} — a later retry will show this request as uncertain.)` }
  }
  return { emailed, error }
}

/** The key is already claimed: return the stored outcome, re-fence a definite non-delivery, or resolve a dead owner's claim. */
async function replayRequest(key: string, hash: string, req: QuoteRequest, rawAttribution: unknown, deps: SubmitDeps): Promise<SubmitResult> {
  const db = getDb()
  const cfg = { pollMs: 300, polls: 5, staleMs: 15_000, ...(deps.replay ?? {}) }
  const inbox = quoteInbox(deps.env ?? process.env)
  const source = classifySource(cleanAttribution(rawAttribution))
  for (let attempt = 0; ; attempt++) {
    const [row] = await db.select().from(quoteRequests).where(eq(quoteRequests.requestKey, key)).limit(1)
    if (!row) throw new Error(`quote request claim for key ${key} disappeared`) // unique row; nothing deletes it
    if (row.payloadHash !== hash) throw new QuoteRequestConflictError()
    if (row.emailStatus === 'sent') return { leadId: row.leadId, emailed: 'sent', inbox, error: null, replayed: true }
    if (row.emailStatus === 'uncertain') {
      // May already be in the shop inbox — never resent automatically (same rule as requeueNotification).
      return { leadId: row.leadId, emailed: 'uncertain', inbox, error: row.emailError, replayed: true }
    }
    if ((RETRYABLE_EMAIL_STATUSES as readonly string[]).includes(row.emailStatus)) {
      // Definite non-delivery: of N concurrent replays, the fence lets exactly one send again.
      const token = await fenceSend(db, row.id, {})
      if (token !== null) {
        const { emailed, error } = await sendWithToken(row.id, token, row.leadId, req, source, deps, deps.now ?? new Date())
        return { leadId: row.leadId, emailed, inbox, error, replayed: true }
      }
      continue // lost the fence — loop and read the winner's outcome
    }
    // 'processing'. The lead ALWAYS exists (atomic claim); the only question is the state of the send.
    const cutoff = new Date(Date.now() - cfg.staleMs)
    if (row.emailAttempts === 0 && row.updatedAt < cutoff) {
      // The owner died after the claim but before ever being authorized to send: attempts=0 proves no
      // send was fenced, so sending now cannot duplicate anything. The fence (0→1) still arbitrates —
      // if the "dead" owner was merely slow and fences first, we lose here and follow its outcome.
      const token = await fenceSend(db, row.id, { firstSend: true, staleBefore: cutoff })
      if (token !== null) {
        const { emailed, error } = await sendWithToken(row.id, token, row.leadId, req, source, deps, deps.now ?? new Date())
        return { leadId: row.leadId, emailed, inbox, error, replayed: true }
      }
      continue
    }
    if (row.emailAttempts > 0 && row.updatedAt < cutoff) {
      // A fenced send never recorded its outcome (sender died or its recording write failed): the email
      // MAY have gone out, so mark it uncertain — never resend. The token guard means a live sender that
      // finally reports a definite outcome overwrites this marker with the truth.
      const [marked] = await db.update(quoteRequests)
        .set({ emailStatus: 'uncertain', emailError: `${UNCERTAIN_NOTE} (An earlier attempt did not record its outcome.)`, updatedAt: new Date() })
        .where(and(eq(quoteRequests.id, row.id), eq(quoteRequests.emailStatus, 'processing'), eq(quoteRequests.emailAttempts, row.emailAttempts), lt(quoteRequests.updatedAt, cutoff))).returning()
      if (marked) return { leadId: row.leadId, emailed: 'uncertain', inbox, error: marked.emailError, replayed: true }
      continue
    }
    if (attempt >= cfg.polls) throw new QuoteStillProcessingError()
    await sleep(cfg.pollMs)
  }
}

/**
 * Transactional appointment messages (confirmation / reminder / cancellation / reschedule). These are
 * OPERATIONAL notices — never marketing, never gated on or creating marketing consent.
 *
 * Delivery runs from a durable outbox (appointment_notifications) written in the same transaction as
 * the booking change, so a mail problem can never lose or undo an appointment. A notice is only
 * marked 'sent' when a real provider accepted it. With no provider configured it is marked
 * 'not_configured' — the appointment page shows that honestly; nothing pretends an email went out.
 *
 * Provider: Postmark when APPOINTMENT_EMAIL_PROVIDER=postmark + POSTMARK_SERVER_TOKEN +
 * APPOINTMENT_EMAIL_FROM are set (owner decision pending). SMS is not used: Pitt Stop has no approved
 * A2P registration for texting.
 *
 * DELIVERY CERTAINTY: a result is 'sent' only on a readable acceptance, and 'failed' only when non-delivery is
 * established (a definite rejection, or a connection that never opened). Anything that might have been accepted —
 * a lost or timed-out response, an unreadable/incomplete 2xx, a server error — is 'uncertain': recorded for staff,
 * never retried automatically and never re-queueable, so an accepted email can't be sent twice.
 *
 * TEST SAFETY: when APPOINTMENT_EMAIL_ALLOWLIST is set (comma-separated addresses and/or @domains), only those
 * recipients are sent to. Every other notice is HELD, not discarded: it stays `pending` with the reason recorded,
 * so a controlled test can never silently consume a real customer's confirmation or reminder — once the allowlist
 * is removed those notices go out on the next dispatch (staleness is re-checked then, so anything that has since
 * become irrelevant still won't send). Set the allowlist for any controlled test with a live provider; remove it
 * only when the owner approves real customer email.
 *
 * REPLIES: APPOINTMENT_EMAIL_REPLY_TO sets Reply-To on every customer notice, so replies reach a monitored human
 * inbox instead of the unattended sending address. Unset = no Reply-To header (replies go to APPOINTMENT_EMAIL_FROM).
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { appointments, appointmentEvents, appointmentNotifications } from './schema'
import { type BookingConfig, formatDateLabel, formatTimeLabel } from './policy'
import { manageUrl, publicBaseUrl } from './tokens'
import { getBookingConfig, type Appointment } from './db'

export interface EmailMessage { to: string; subject: string; text: string; html?: string; replyTo?: string | null }
export type DeliveryResult =
  | { status: 'sent'; providerMessageId: string }
  | { status: 'not_configured' }
  /** Definitely NOT accepted. `retryable: false` = permanent (rejected address, bad credentials); default true. */
  | { status: 'failed'; error: string; retryable?: boolean }
  /** The provider may have accepted it. Never resend automatically. */
  | { status: 'uncertain'; error: string }
  | { status: 'blocked'; reason: string }

export const UNCERTAIN_NOTE = 'Delivery uncertain — the email may have been delivered, so it is not resent automatically.'

/** Stable marker for a test-mode hold. A held notice and a retryable failure are BOTH 'pending' with an
 *  error, so the two are only distinguishable by this prefix — staff must never read a real delivery
 *  failure as a harmless test artefact. */
export const TEST_MODE_HOLD_PREFIX = 'Test mode:'
export const isTestModeHold = (n: { status: string; error: string | null }): boolean =>
  n.status === 'pending' && !!n.error && n.error.startsWith(TEST_MODE_HOLD_PREFIX)

/** Network error codes that mean the connection never opened, so the request cannot have reached the provider. */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
function errorCodes(err: unknown): string[] {
  const cause = (err as { cause?: { code?: unknown; errors?: { code?: unknown }[] } })?.cause
  const codes = [cause?.code, ...(cause?.errors ?? []).map((e) => e?.code)]
  return codes.filter((c): c is string => typeof c === 'string')
}
const neverConnected = (err: unknown) => { const c = errorCodes(err); return c.length > 0 && c.every((x) => NEVER_CONNECTED.has(x)) }
const short = (s: string) => s.slice(0, 500)
export interface TransactionalEmailProvider { name: string; live: boolean; send(msg: EmailMessage): Promise<DeliveryResult> }

export class NotConfiguredEmailProvider implements TransactionalEmailProvider {
  readonly name = 'none'
  readonly live = false
  async send(): Promise<DeliveryResult> { return { status: 'not_configured' } }
}

export class PostmarkEmailProvider implements TransactionalEmailProvider {
  readonly name = 'postmark'
  readonly live = true
  constructor(private token: string, private from: string, private fetchImpl: typeof fetch = fetch) {}
  async send(msg: EmailMessage): Promise<DeliveryResult> {
    let res: Response
    try {
      res = await this.fetchImpl('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': this.token },
        body: JSON.stringify({ From: this.from, To: msg.to, Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html || undefined, ReplyTo: msg.replyTo || undefined, MessageStream: 'outbound' }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      // Only a connection that never opened proves Postmark didn't get it; a reset, lost response or timeout
      // may come after Postmark accepted the message.
      if (neverConnected(err)) return { status: 'failed', retryable: true, error: short(`Could not connect to Postmark (${errorCodes(err).join(', ')}).`) }
      return { status: 'uncertain', error: short(`${UNCERTAIN_NOTE} (${why})`) }
    }
    let body: { ErrorCode?: unknown; Message?: unknown; MessageID?: unknown } | null = null
    try { body = JSON.parse(await res.text()) } catch { body = null }
    const message = typeof body?.Message === 'string' ? body.Message : ''
    if (res.ok) {
      if (body && body.ErrorCode === 0 && typeof body.MessageID === 'string' && body.MessageID) return { status: 'sent', providerMessageId: body.MessageID }
      return { status: 'uncertain', error: short(`${UNCERTAIN_NOTE} (Postmark answered ${res.status} without readable acceptance details.)`) }
    }
    // Not accepted, and saying so: try again later.
    if (res.status === 408 || res.status === 429 || res.status === 503) return { status: 'failed', retryable: true, error: short(`${res.status} ${message || 'Postmark is busy or unavailable'}`) }
    // Any other server error: Postmark may have processed it before failing.
    if (res.status >= 500) return { status: 'uncertain', error: short(`${UNCERTAIN_NOTE} (Postmark answered ${res.status}${message ? `: ${message}` : ''}.)`) }
    // 4xx: Postmark rejected the request (invalid or inactive recipient, sender, credentials…). Nothing was accepted,
    // and the same request would be rejected again — staff can queue it again after fixing the cause.
    return { status: 'failed', retryable: false, error: short(`${res.status} ${message || 'Postmark rejected the message'}`) }
  }
}

/** Test mode: only allowlisted recipients reach the real provider. */
export class AllowlistEmailProvider implements TransactionalEmailProvider {
  readonly live: boolean
  readonly name: string
  constructor(private inner: TransactionalEmailProvider, private allow: string[]) { this.live = inner.live; this.name = `${inner.name}+allowlist` }
  allows(to: string): boolean {
    const addr = to.trim().toLowerCase()
    return this.allow.some((a) => (a.startsWith('@') ? addr.endsWith(a) : addr === a))
  }
  async send(msg: EmailMessage): Promise<DeliveryResult> {
    if (!this.allows(msg.to)) return { status: 'blocked', reason: `${TEST_MODE_HOLD_PREFIX} recipient is not on APPOINTMENT_EMAIL_ALLOWLIST, so nothing was sent.` }
    return this.inner.send(msg)
  }
}

/**
 * Reply-To for customer notices. The sending address is unattended, so replies must be steered to a monitored
 * mailbox (e.g. the shared service group). Returns null when unset — then replies fall back to the From address,
 * which is only safe if that address is itself a real monitored mailbox.
 */
export function replyToAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.APPOINTMENT_EMAIL_REPLY_TO ?? '').trim()
  return v || null
}

export function transactionalEmailProvider(env: NodeJS.ProcessEnv = process.env): TransactionalEmailProvider {
  const base: TransactionalEmailProvider = env.APPOINTMENT_EMAIL_PROVIDER === 'postmark' && env.POSTMARK_SERVER_TOKEN && env.APPOINTMENT_EMAIL_FROM
    ? new PostmarkEmailProvider(env.POSTMARK_SERVER_TOKEN, env.APPOINTMENT_EMAIL_FROM)
    : new NotConfiguredEmailProvider()
  const allow = (env.APPOINTMENT_EMAIL_ALLOWLIST ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  return allow.length ? new AllowlistEmailProvider(base, allow) : base
}

// ── Message copy ──────────────────────────────────────────────────────────────

const SHOP = 'Pitt Stop Detail & Auto Sales'

function detailRows(a: Appointment, cfg: BookingConfig): [string, string][] {
  const vehicle = vehicleLabel(a)
  return ([
    ['Drop-off', `${formatDateLabel(a.localDate)} at ${formatTimeLabel(a.localTime)}`],
    ['Service', a.serviceLabels],
    ['Vehicle', vehicle],
    ['Reference', a.reference],
    ['Location', cfg.address],
    ['Phone', cfg.phone],
  ] as [string, string][]).filter(([, v]) => v)
}
const vehicleLabel = (a: Pick<Appointment, 'vehicleYear' | 'vehicleMake' | 'vehicleModel'>) =>
  [a.vehicleYear, a.vehicleMake === 'Trailer' ? null : a.vehicleMake, a.vehicleModel].filter(Boolean).join(' ')
function details(a: Appointment, cfg: BookingConfig): string {
  return detailRows(a, cfg).map(([k, v]) => `${k}: ${v}`).join('\n')
}

// ── Branded HTML (matches pittstopdetailandautosales.com: navy bar, logo, red pill button) ──────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const FONT = "Roboto, Arial, Helvetica, sans-serif"

export function brandedHtml(input: { preheader: string; heading: string; intro: string; rows?: [string, string][]; note?: string; button?: { label: string; href: string }; footnote?: string; cfg: Pick<BookingConfig, 'phone' | 'address'> }): string {
  const { cfg } = input
  const tel = cfg.phone.replace(/[^\d+]/g, '')
  const rows = (input.rows ?? []).map(([k, v]) => `<tr><td style="padding:10px 0;border-top:1px solid #e2e2e2;color:#555555;font-size:14px;width:96px;vertical-align:top">${esc(k)}</td><td style="padding:10px 0;border-top:1px solid #e2e2e2;color:#212934;font-size:15px;font-weight:${k === 'Drop-off' ? 700 : 400}">${esc(v)}</td></tr>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(input.heading)}</title></head>
<body style="margin:0;padding:0;background:#f8f9fa;font-family:${FONT}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(input.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa"><tr><td align="center" style="padding:0 12px 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:#0d4469;color:#ffffff;font-size:13px;padding:10px 20px;text-align:center"><a href="tel:${tel}" style="color:#ffffff;text-decoration:none">${esc(cfg.phone)}</a></td></tr>
<tr><td style="background:#ffffff;padding:16px 20px;border-bottom:3px solid #eb0523"><img src="${esc(publicBaseUrl())}/book/pittstop-logo.png" width="152" height="48" alt="Pitt Stop Detail &amp; Auto Sales" style="display:block;border:0"></td></tr>
<tr><td style="background:#ffffff;padding:24px 20px 8px">
<h1 style="margin:0 0 8px;color:#023456;font-size:24px;line-height:1.25;font-weight:700">${esc(input.heading)}</h1>
<p style="margin:0 0 16px;color:#212934;font-size:16px;line-height:1.5">${esc(input.intro)}</p>
${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e2e2">${rows}</table>` : ''}
${input.note ? `<p style="margin:16px 0 0;color:#212934;font-size:15px;line-height:1.5">${esc(input.note)}</p>` : ''}
${input.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px"><tr><td style="border-radius:30px;background:#eb0523;background-image:linear-gradient(90deg,#eb0523,#ac1d0e)"><a href="${esc(input.button.href)}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:16px;font-weight:500;text-decoration:none;border-radius:30px">${esc(input.button.label)}</a></td></tr></table>` : ''}
${input.footnote ? `<p style="margin:16px 0 0;color:#555555;font-size:13px;line-height:1.5">${esc(input.footnote)}</p>` : ''}
</td></tr>
<tr><td style="background:#ffffff;padding:16px 20px 24px;color:#555555;font-size:13px;line-height:1.5;border-top:1px solid #e2e2e2">Pitt Stop Detail &amp; Auto Sales<br>${esc(cfg.address)}<br><a href="tel:${tel}" style="color:#023456">${esc(cfg.phone)}</a></td></tr>
</table></td></tr></table></body></html>`
}

export function renderMessage(kind: string, a: Appointment, cfg: BookingConfig, link = manageUrl(a.id)): { subject: string; text: string; html?: string } {
  const when = `${formatDateLabel(a.localDate)} at ${formatTimeLabel(a.localTime)}`
  const hi = `Hi ${a.firstName},`
  if (kind === 'confirmation') {
    return {
      subject: `Drop-off confirmed — ${when}`,
      text: `${hi}\n\nYour drop-off with ${SHOP} is confirmed for ${when}. This is the time we receive your vehicle, not a promised finish time.\n\n${details(a, cfg)}\n\n${cfg.instructions}\n\n${cfg.cancellationPolicy}\nView or cancel: ${link}\n\n— ${SHOP}`,
      html: brandedHtml({
        preheader: `Drop-off ${when} · Reference ${a.reference}`,
        heading: 'Your drop-off is confirmed',
        intro: `${hi} we have you down for ${when}. This is the time we receive your vehicle, not a promised finish time.`,
        rows: detailRows(a, cfg), note: cfg.instructions,
        button: { label: 'View or cancel', href: link }, footnote: cfg.cancellationPolicy, cfg,
      }),
    }
  }
  if (kind === 'reminder') {
    return {
      subject: `Reminder: drop-off ${when}`,
      text: `${hi}\n\nThis is a reminder of your drop-off with ${SHOP} on ${when}.\n\n${details(a, cfg)}\n\n${cfg.instructions}\n\nNeed to cancel? ${link}\n\n— ${SHOP}`,
    }
  }
  if (kind === 'reschedule') {
    return {
      subject: `Appointment moved — ${when}`,
      text: `${hi}\n\nYour appointment with ${SHOP} has been moved. It is now confirmed for ${when}.\n\n${details(a, cfg)}\n\nView or cancel: ${link}\n\n— ${SHOP}`,
    }
  }
  return {
    subject: `Appointment cancelled — ${when}`,
    text: `${hi}\n\nYour appointment with ${SHOP} for ${when} (reference ${a.reference}) has been cancelled.\n\nTo book again, call ${cfg.phone} or use our booking page.\n\n— ${SHOP}`,
  }
}

// ── Outbox dispatch ───────────────────────────────────────────────────────────

/** Why a due notice should no longer go out (appointment changed since it was queued). */
/** How long after a drop-off a cancellation notice is still worth sending. */
const CANCELLATION_GRACE_MS = 2 * 24 * 3_600_000

export function staleReason(kind: string, a: Appointment, now: Date): string | null {
  // A cancellation is the one notice that stays true after the fact, so it has no drop-off rule — but it
  // still must not arrive long afterwards (e.g. released from a long test-mode hold weeks later).
  if (kind === 'cancellation' && now.getTime() - a.startsAt.getTime() > CANCELLATION_GRACE_MS) return 'too late to be useful'
  if (kind === 'reminder' && a.status !== 'confirmed') return `appointment ${a.status}`
  if (kind === 'reminder' && a.startsAt.getTime() <= now.getTime()) return 'drop-off time passed'
  if ((kind === 'confirmation' || kind === 'reschedule') && a.status === 'cancelled') return 'appointment cancelled'
  // A confirmation is only true while the drop-off is still ahead. Once it has passed, telling the customer
  // their drop-off "is confirmed" for a past time is wrong and confusing — this is what stops a notice that
  // sat un-sent (no provider, a failure, a staff retry weeks later) from going out as a backdated
  // confirmation. A cancellation notice is still always allowed: it stays true after the fact.
  if ((kind === 'confirmation' || kind === 'reschedule') && a.startsAt.getTime() <= now.getTime()) return 'drop-off time passed'
  return null
}

const MAX_ATTEMPTS = 3

/**
 * Does this skip mean the customer never got told something they should have been told?
 * A reminder dropped because the appointment was cancelled is deliberate housekeeping. A CONFIRMATION
 * dropped because the drop-off has already passed is a MISS: that customer booked and was never confirmed.
 * Misses get an appointment_events row so they show in History and cannot pass as routine.
 */
/** Kinds whose dedupe key embeds the drop-off time they were queued for. */
const TIMED_KEY_KINDS = new Set(['reminder', 'reschedule'])

// 'too late to be useful' belongs here: it means a cancellation the customer was never actually told about.
const ANOMALY_REASONS = new Set(['appointment missing', 'no email address', 'too late to be useful'])
export function isMissedSend(kind: string, reason: string): boolean {
  if (ANOMALY_REASONS.has(reason)) return true
  return reason === 'drop-off time passed' && (kind === 'confirmation' || kind === 'reschedule')
}

/** Send due notices. Safe to run concurrently: each row is claimed with a conditional update. */
export async function dispatchDue(opts: { now?: Date; limit?: number; appointmentId?: string; provider?: TransactionalEmailProvider } = {}): Promise<{ sent: number; notConfigured: number; failed: number; uncertain: number; skipped: number; held: number }> {
  const db = getDb()
  const now = opts.now ?? new Date()
  const provider = opts.provider ?? transactionalEmailProvider()
  const replyTo = replyToAddress()
  const cfg = await getBookingConfig()
  const due = await db.select().from(appointmentNotifications).where(and(
    eq(appointmentNotifications.status, 'pending'), lte(appointmentNotifications.sendAfter, now),
    ...(opts.appointmentId ? [eq(appointmentNotifications.appointmentId, opts.appointmentId)] : []),
  )).orderBy(asc(appointmentNotifications.sendAfter)).limit(opts.limit ?? 50)
  const tally = { sent: 0, notConfigured: 0, failed: 0, uncertain: 0, skipped: 0, held: 0 }
  /** Only write an outcome onto the row we are still holding. If something else moved it on while the
   *  provider call was in flight (a reschedule superseding this notice), our write must not resurrect it. */
  const sending = (id: string) => and(eq(appointmentNotifications.id, id), eq(appointmentNotifications.status, 'sending'))
  for (const n of due) {
    const [claimed] = await db.update(appointmentNotifications).set({ status: 'sending', attempts: sql`${appointmentNotifications.attempts} + 1` })
      .where(and(eq(appointmentNotifications.id, n.id), eq(appointmentNotifications.status, 'pending'))).returning()
    if (!claimed) continue
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, n.appointmentId)).limit(1)
    // A reminder and a reschedule notice both name a specific drop-off time in their dedupe key
    // (db.ts: `${id}:${kind}:${startsAt}`). If the appointment has since moved, THIS row is the superseded
    // one — the reschedule queued a fresh notice for the new time. Detecting it here, rather than relying
    // only on the reschedule's "skip pending" sweep, is what makes it safe for a reschedule to land while
    // this very row is in flight: the sweep cannot touch a 'sending' row, but this check can. An unexpected
    // key shape fails OPEN (the notice still sends) rather than retiring a live notice.
    const timedKey = appt && TIMED_KEY_KINDS.has(n.kind) ? `${n.appointmentId}:${n.kind}:` : ''
    const superseded = !!appt && !!timedKey && n.dedupeKey.startsWith(timedKey)
      && n.dedupeKey !== `${timedKey}${appt.startsAt.toISOString()}`
    const stale = !appt ? 'appointment missing'
      : !n.toAddress ? 'no email address'
      : superseded ? 'superseded by a reschedule'
      : staleReason(n.kind, appt, now)
    if (stale || !appt) {
      const reason = stale ?? 'appointment missing'
      await db.update(appointmentNotifications).set({ status: 'skipped', error: reason }).where(sending(n.id))
      // A miss is never silent: without this, a confirmation held through its own drop-off ended up
      // labelled "Not needed" on the staff screen with nothing in History to show the customer was missed.
      if (appt && isMissedSend(n.kind, reason)) {
        await db.insert(appointmentEvents).values({ appointmentId: n.appointmentId, eventType: 'email_not_sent', actor: 'system', meta: { kind: n.kind, notificationId: n.id, reason } })
      }
      tally.skipped++
      continue
    }
    const msg = renderMessage(n.kind, appt, cfg)
    const res = await provider.send({ to: n.toAddress!, subject: msg.subject, text: msg.text, html: msg.html, replyTo })
    if (res.status === 'sent') {
      await db.update(appointmentNotifications).set({ status: 'sent', sentAt: new Date(), provider: provider.name, providerMessageId: res.providerMessageId, error: null })
        .where(eq(appointmentNotifications.id, n.id))
      tally.sent++
    } else if (res.status === 'blocked') {
      // TEST-MODE HOLD — never a discard. Not being on the allowlist says nothing about the notice: it is a
      // legitimate customer message that must still go out once the allowlist is removed. So it returns to
      // 'pending' rather than a terminal 'skipped', and the claim's attempt is undone so a held notice never
      // burns a real delivery attempt. Nothing was sent, so there is no duplicate risk in sending it later.
      // sendAfter is left ALONE: the notice becomes due again immediately, so lifting the allowlist releases
      // it on the very next dispatch instead of leaving it to expire against its own drop-off.
      await db.update(appointmentNotifications).set({
        status: 'pending', provider: provider.name, error: res.reason,
        attempts: sql`greatest(${appointmentNotifications.attempts} - 1, 0)`,
      }).where(sending(n.id))
      tally.held++
    } else if (res.status === 'not_configured') {
      await db.update(appointmentNotifications).set({ status: 'not_configured', provider: provider.name, error: 'No transactional email provider is configured.' })
        .where(sending(n.id))
      tally.notConfigured++
    } else if (res.status === 'uncertain') {
      // It may have been delivered: never resent automatically, and requeueNotification refuses it.
      await db.update(appointmentNotifications).set({ status: 'uncertain', provider: provider.name, error: res.error })
        .where(sending(n.id))
      await db.insert(appointmentEvents).values({ appointmentId: n.appointmentId, eventType: 'email_uncertain', actor: 'system', meta: { kind: n.kind, notificationId: n.id, provider: provider.name } })
      tally.uncertain++
    } else {
      // Definitely not delivered: retry a temporary failure; a permanent one waits for staff.
      const retry = res.retryable !== false && claimed.attempts < MAX_ATTEMPTS
      await db.update(appointmentNotifications).set({
        status: retry ? 'pending' : 'failed', provider: provider.name, error: res.error,
        sendAfter: retry ? new Date(now.getTime() + 15 * 60_000) : n.sendAfter,
      }).where(sending(n.id))
      if (!retry) await db.insert(appointmentEvents).values({ appointmentId: n.appointmentId, eventType: 'email_failed', actor: 'system', meta: { kind: n.kind, notificationId: n.id, provider: provider.name } })
      tally.failed++
    }
  }
  return tally
}

/** Staff "retry": re-queue a failed / not-configured notice (e.g. after a provider is set up). Never an
 *  'uncertain' one — it may already have been delivered. */
export async function requeueNotification(id: string): Promise<void> {
  await getDb().update(appointmentNotifications).set({ status: 'pending', sendAfter: new Date(), error: null })
    .where(and(eq(appointmentNotifications.id, id), sql`${appointmentNotifications.status} IN ('failed', 'not_configured')`))
}

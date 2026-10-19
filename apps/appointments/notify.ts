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
 */
import { and, eq, lte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { appointments, appointmentNotifications } from './schema'
import { type BookingConfig, formatDateLabel, formatTimeLabel } from './policy'
import { manageUrl } from './tokens'
import { getBookingConfig, type Appointment } from './db'

export interface EmailMessage { to: string; subject: string; text: string; replyTo?: string | null }
export type DeliveryResult = { status: 'sent'; providerMessageId: string } | { status: 'not_configured' } | { status: 'failed'; error: string }
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
    try {
      const res = await this.fetchImpl('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': this.token },
        body: JSON.stringify({ From: this.from, To: msg.to, Subject: msg.subject, TextBody: msg.text, ReplyTo: msg.replyTo || undefined, MessageStream: 'outbound' }),
      })
      const body = await res.json().catch(() => ({})) as { ErrorCode?: number; Message?: string; MessageID?: string }
      if (res.ok && body.ErrorCode === 0 && body.MessageID) return { status: 'sent', providerMessageId: body.MessageID }
      return { status: 'failed', error: `${res.status} ${body.Message ?? 'Postmark rejected the message'}`.slice(0, 500) }
    } catch (err) {
      return { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }
    }
  }
}

export function transactionalEmailProvider(env: NodeJS.ProcessEnv = process.env): TransactionalEmailProvider {
  if (env.APPOINTMENT_EMAIL_PROVIDER === 'postmark' && env.POSTMARK_SERVER_TOKEN && env.APPOINTMENT_EMAIL_FROM) {
    return new PostmarkEmailProvider(env.POSTMARK_SERVER_TOKEN, env.APPOINTMENT_EMAIL_FROM)
  }
  return new NotConfiguredEmailProvider()
}

// ── Message copy ──────────────────────────────────────────────────────────────

const SHOP = 'Pitt Stop Detail & Auto Sales'

function details(a: Appointment, cfg: BookingConfig): string {
  const vehicle = [a.vehicleYear, a.vehicleMake, a.vehicleModel].filter(Boolean).join(' ')
  return [
    `Drop-off: ${formatDateLabel(a.localDate)} at ${formatTimeLabel(a.localTime)}`,
    `Service: ${a.serviceLabels}`,
    vehicle ? `Vehicle: ${vehicle}` : null,
    `Reference: ${a.reference}`,
    `Location: ${cfg.address}`,
    `Phone: ${cfg.phone}`,
  ].filter(Boolean).join('\n')
}

export function renderMessage(kind: string, a: Appointment, cfg: BookingConfig, link = manageUrl(a.id)): { subject: string; text: string } {
  const when = `${formatDateLabel(a.localDate)} at ${formatTimeLabel(a.localTime)}`
  const hi = `Hi ${a.firstName},`
  if (kind === 'confirmation') {
    return {
      subject: `Appointment confirmed — ${when}`,
      text: `${hi}\n\nYour appointment with ${SHOP} is confirmed for ${when}.\n\n${details(a, cfg)}\n\n${cfg.instructions}\n\n${cfg.cancellationPolicy}\nView or cancel: ${link}\n\n— ${SHOP}`,
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
export function staleReason(kind: string, a: Appointment, now: Date): string | null {
  if (kind === 'reminder' && a.status !== 'confirmed') return `appointment ${a.status}`
  if (kind === 'reminder' && a.startsAt.getTime() <= now.getTime()) return 'drop-off time passed'
  if ((kind === 'confirmation' || kind === 'reschedule') && a.status === 'cancelled') return 'appointment cancelled'
  return null
}

const MAX_ATTEMPTS = 3

/** Send due notices. Safe to run concurrently: each row is claimed with a conditional update. */
export async function dispatchDue(opts: { now?: Date; limit?: number; appointmentId?: string; provider?: TransactionalEmailProvider } = {}): Promise<{ sent: number; notConfigured: number; failed: number; skipped: number }> {
  const db = getDb()
  const now = opts.now ?? new Date()
  const provider = opts.provider ?? transactionalEmailProvider()
  const cfg = await getBookingConfig()
  const due = await db.select().from(appointmentNotifications).where(and(
    eq(appointmentNotifications.status, 'pending'), lte(appointmentNotifications.sendAfter, now),
    ...(opts.appointmentId ? [eq(appointmentNotifications.appointmentId, opts.appointmentId)] : []),
  )).limit(opts.limit ?? 50)
  const tally = { sent: 0, notConfigured: 0, failed: 0, skipped: 0 }
  for (const n of due) {
    const [claimed] = await db.update(appointmentNotifications).set({ status: 'sending', attempts: sql`${appointmentNotifications.attempts} + 1` })
      .where(and(eq(appointmentNotifications.id, n.id), eq(appointmentNotifications.status, 'pending'))).returning()
    if (!claimed) continue
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, n.appointmentId)).limit(1)
    const stale = !appt ? 'appointment missing' : !n.toAddress ? 'no email address' : staleReason(n.kind, appt, now)
    if (stale || !appt) {
      await db.update(appointmentNotifications).set({ status: 'skipped', error: stale }).where(eq(appointmentNotifications.id, n.id))
      tally.skipped++
      continue
    }
    const msg = renderMessage(n.kind, appt, cfg)
    const res = await provider.send({ to: n.toAddress!, subject: msg.subject, text: msg.text })
    if (res.status === 'sent') {
      await db.update(appointmentNotifications).set({ status: 'sent', sentAt: new Date(), provider: provider.name, providerMessageId: res.providerMessageId, error: null })
        .where(eq(appointmentNotifications.id, n.id))
      tally.sent++
    } else if (res.status === 'not_configured') {
      await db.update(appointmentNotifications).set({ status: 'not_configured', provider: provider.name, error: 'No transactional email provider is configured.' })
        .where(eq(appointmentNotifications.id, n.id))
      tally.notConfigured++
    } else {
      const retry = claimed.attempts < MAX_ATTEMPTS
      await db.update(appointmentNotifications).set({
        status: retry ? 'pending' : 'failed', provider: provider.name, error: res.error,
        sendAfter: retry ? new Date(now.getTime() + 15 * 60_000) : n.sendAfter,
      }).where(eq(appointmentNotifications.id, n.id))
      tally.failed++
    }
  }
  return tally
}

/** Staff "retry": re-queue a failed / not-configured notice (e.g. after a provider is set up). */
export async function requeueNotification(id: string): Promise<void> {
  await getDb().update(appointmentNotifications).set({ status: 'pending', sendAfter: new Date(), error: null })
    .where(and(eq(appointmentNotifications.id, id), sql`${appointmentNotifications.status} IN ('failed', 'not_configured')`))
}

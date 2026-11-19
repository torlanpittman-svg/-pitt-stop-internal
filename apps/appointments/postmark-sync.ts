/**
 * Postmark ⇄ our email preferences, for the BROADCAST stream that carries Lead Recovery follow-ups.
 *
 * WHY: Postmark adds its own unsubscribe link to broadcast mail and keeps its own suppression list (unsubscribes,
 * hard bounces, spam complaints). Postmark already refuses to send to a suppressed address on that stream, but our
 * own records would not know — the customer would still look emailable here and to any other marketing email path.
 *
 * HOW (the simplest reliable way): PULL the stream's suppression list with the server token the app already has
 * (GET /message-streams/{id}/suppressions/dump) on every recovery run. No public webhook, no new secret, nothing to
 * configure in Postmark. For each suppressed address: every customer record with that address is marked not
 * eligible for marketing email (marketing_preferences.email_eligible = false — the flag every marketing email path
 * and the recovery gate already check), an append-only opt_out row is added to the consent trail, and any running
 * recovery sequence for that address is stopped. SMS consent is never touched. Idempotent: an address already
 * blocked is skipped, so repeated runs write nothing.
 *
 * One-way on purpose: removing a suppression in Postmark does NOT re-enable anyone here; a manager does that.
 * Appointment emails (confirmation / reminder / reschedule / cancellation) are not affected by any of this.
 */
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { recoveryMessageStream } from './notify'

const API = 'https://api.postmarkapp.com'
const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : ((r as { rows?: Record<string, unknown>[] })?.rows ?? [])
const exec = async (q: SQL) => rowsOf(await getDb().execute(q))

function postmark(env: NodeJS.ProcessEnv): { token: string; stream: string } | null {
  if (env.APPOINTMENT_EMAIL_PROVIDER !== 'postmark' || !env.POSTMARK_SERVER_TOKEN) return null
  return { token: env.POSTMARK_SERVER_TOKEN, stream: recoveryMessageStream(env) }
}
async function get(path: string, token: string, fetchImpl: typeof fetch): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetchImpl(`${API}${path}`, { headers: { Accept: 'application/json', 'X-Postmark-Server-Token': token }, signal: AbortSignal.timeout(10_000) })
  let body: Record<string, unknown> | null = null
  try { body = JSON.parse(await res.text()) } catch { body = null }
  return { status: res.status, body }
}

export interface StreamCheck {
  configured: boolean; stream: string
  /** True only when Postmark confirms a live BROADCAST stream with this ID. */
  ok: boolean
  type?: string; unsubscribeHandling?: string; archived?: boolean; problem?: string
}

/** Read-only: does the stream recovery emails will use exist, and is it a live broadcast stream? Sends nothing. */
export async function checkRecoveryStream(opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<StreamCheck> {
  const env = opts.env ?? process.env
  const pm = postmark(env)
  const stream = recoveryMessageStream(env)
  if (!pm) return { configured: false, stream, ok: false, problem: 'Postmark is not configured in this environment.' }
  try {
    const { status, body } = await get(`/message-streams/${encodeURIComponent(stream)}`, pm.token, opts.fetchImpl ?? fetch)
    if (status !== 200 || !body) return { configured: true, stream, ok: false, problem: `Postmark answered ${status}${typeof body?.Message === 'string' ? `: ${body.Message}` : ''}`.slice(0, 200) }
    const type = String(body.MessageStreamType ?? '')
    const archived = !!body.ArchivedAt
    const handling = String((body.SubscriptionManagementConfiguration as { UnsubscribeHandlingType?: unknown } | undefined)?.UnsubscribeHandlingType ?? '')
    const problem = archived ? 'The stream is archived.' : type !== 'Broadcasts' ? `The stream is "${type}", not a broadcast stream.` : undefined
    return { configured: true, stream, ok: !problem, type, unsubscribeHandling: handling, archived, ...(problem ? { problem } : {}) }
  } catch (err) {
    return { configured: true, stream, ok: false, problem: `Could not reach Postmark (${err instanceof Error ? err.name : 'error'}).` }
  }
}

export interface SuppressionSync { enabled: boolean; seen: number; customersBlocked: number; sequencesStopped: number; problem?: string }

/** Pull the broadcast stream's suppression list into our preferences. Safe to run any number of times. */
export async function syncPostmarkSuppressions(opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<SuppressionSync> {
  const pm = postmark(opts.env ?? process.env)
  const out: SuppressionSync = { enabled: !!pm, seen: 0, customersBlocked: 0, sequencesStopped: 0 }
  if (!pm) return out
  const { status, body } = await get(`/message-streams/${encodeURIComponent(pm.stream)}/suppressions/dump`, pm.token, opts.fetchImpl ?? fetch)
  if (status !== 200 || !Array.isArray(body?.Suppressions)) return { ...out, problem: `Postmark answered ${status}` }
  const list = (body.Suppressions as { EmailAddress?: unknown; SuppressionReason?: unknown; Origin?: unknown }[])
    .map((s) => ({ email: String(s.EmailAddress ?? '').trim().toLowerCase(), reason: String(s.SuppressionReason ?? 'Unknown').slice(0, 40), origin: String(s.Origin ?? '').slice(0, 20) }))
    .filter((s) => s.email.includes('@'))
  out.seen = list.length
  const { stopSequence, REASONS } = await import('./recovery')
  for (const s of list) {
    const note = `postmark:${s.reason}`
    // One statement: block marketing email for every customer with this address that is not blocked yet, and
    // append the opt-out to the consent trail for exactly those customers.
    const blocked = await exec(sql`WITH c AS (
        SELECT id FROM customers WHERE normalized_email = ${s.email}
      ), up AS (
        INSERT INTO marketing_preferences (customer_id, email_eligible, unsubscribe_reason)
        SELECT id, false, ${note} FROM c
        ON CONFLICT (customer_id) DO UPDATE SET email_eligible = false, unsubscribe_reason = coalesce(marketing_preferences.unsubscribe_reason, EXCLUDED.unsubscribe_reason), updated_at = now()
          WHERE marketing_preferences.email_eligible = true
        RETURNING customer_id
      ), ev AS (
        INSERT INTO marketing_consent_events (customer_id, channel, event, source, meta)
        SELECT customer_id, 'email', 'opt_out', 'email_provider', ${JSON.stringify({ provider: 'postmark', stream: pm.stream, reason: s.reason, origin: s.origin })}::jsonb FROM up
      ) SELECT customer_id FROM up`)
    out.customersBlocked += blocked.length
    // Any follow-up sequence still open for this address stops now, not at its next send.
    const open = await exec(sql`SELECT r.id FROM appointment_recoveries r JOIN appointments a ON a.id = r.appointment_id
      WHERE lower(a.email) = ${s.email} AND r.status IN ('active', 'paused')`)
    for (const r of open) if (await stopSequence(String(r.id), 'system', s.reason === 'HardBounce' ? REASONS.undeliverable : REASONS.optedOut)) out.sequencesStopped++
  }
  return out
}

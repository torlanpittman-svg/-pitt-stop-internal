/**
 * Staff push enrolment for new-booking alerts.
 *
 *   GET    — is push configured on the server, the public VAPID key, and this person's devices.
 *   POST   — enrol (or refresh) THIS device for THIS signed-in manager.
 *   DELETE — stop notifying this device (used by the toggle and by Sign out).
 *
 * AUTHORIZATION: proxy.ts gates /api/appointments/* behind the employee session; every handler then
 * independently requires a STRICT manager/admin identity, so enrolment can never be anonymous and a
 * shared/legacy session cannot silently subscribe a device. The private VAPID key is never exposed —
 * only the public key, which is what the browser needs to create a subscription.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authorizedManagerStrictFromRequest, employeeAuthorizedFromRequest } from '@/apps/auth/employee-guard'
import { disableSubscription, listSubscriptions, mayEnrol, saveSubscription } from '@/apps/staff-alerts/db'
import { pushConfig } from '@/apps/staff-alerts/web-push'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const denied = () => NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })

/**
 * A subscription endpoint is a URL our server will POST to, so it has to be a real public HTTPS push
 * service — never loopback, a private address or a bare hostname.
 */
const pushEndpoint = z.string().trim().url().max(1000).refine((value) => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false
  return true
}, 'Unsupported push endpoint.')

const subscribeBody = z.object({
  endpoint: pushEndpoint,
  // base64url, as the browser's PushSubscription produces them.
  p256dh: z.string().trim().regex(/^[\w-]{80,120}$/),
  auth: z.string().trim().regex(/^[\w-]{16,48}$/),
  label: z.string().trim().max(120).optional(),
})

export async function GET(req: Request) {
  const actor = await authorizedManagerStrictFromRequest(req)
  if (!mayEnrol(actor)) return denied()
  const cfg = pushConfig()
  const devices = await listSubscriptions({ employeeKey: actor.key })
  return NextResponse.json({
    ok: true,
    configured: !!cfg,
    publicKey: cfg?.vapid.publicKey ?? null,
    devices: devices.map((d) => ({ id: d.id, label: d.deviceLabel, enrolledAt: d.createdAt, lastSuccessAt: d.lastSuccessAt })),
  })
}

export async function POST(req: Request) {
  const actor = await authorizedManagerStrictFromRequest(req)
  if (!mayEnrol(actor)) return denied()
  if (!pushConfig()) return NextResponse.json({ ok: false, error: 'Push notifications are not configured on the server yet.' }, { status: 503 })

  const parsed = subscribeBody.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'That subscription could not be read.' }, { status: 400 })

  const sub = await saveSubscription(
    { endpoint: parsed.data.endpoint, p256dh: parsed.data.p256dh, auth: parsed.data.auth, deviceLabel: parsed.data.label ?? null },
    actor,
  )
  // Never log the endpoint itself — it is the address of someone's phone.
  logger.info('staff-alerts', 'device_enrolled', { employee: actor.key, subscriptionId: sub.id })
  return NextResponse.json({ ok: true, id: sub.id })
}

/**
 * Releasing a device is NOT a manager action. Whoever is physically holding the phone must be able to
 * cut it loose — above all on Sign out, including a plain employee or a manager whose session has
 * expired taking over a shared shop phone. It is not an escalation: the caller has to present that
 * device's own endpoint, which only that device knows, and the only effect is to STOP notifications.
 * Leaving a stale row enabled would be the worse outcome — the next booking would spend its delivery
 * on an endpoint nobody is listening to.
 */
export async function DELETE(req: Request) {
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 })
  }
  const parsed = z.object({
    endpoint: pushEndpoint,
    // 'signed_out' comes from the Sign out button; 'disabled_by_staff' from the off switch.
    reason: z.enum(['signed_out', 'disabled_by_staff']).default('disabled_by_staff'),
  }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'That subscription could not be read.' }, { status: 400 })
  const removed = await disableSubscription(parsed.data.endpoint, parsed.data.reason)
  return NextResponse.json({ ok: true, removed })
}

/**
 * POST /api/appointments/push/test — send ONE confirmation notification to the caller's OWN enrolled
 * device, on their explicit tap, so they can prove the phone works before relying on it.
 *
 * It is never queued, never retried, and can only target a device enrolled by the signed-in manager
 * themselves — a manager cannot use it to buzz somebody else's phone. No customer data is involved.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authorizedManagerStrictFromRequest } from '@/apps/auth/employee-guard'
import { findSubscription, mayEnrol, sendTestNotification } from '@/apps/staff-alerts/db'
import { MAX_ENDPOINT_LENGTH, isAllowedPushEndpoint } from '@/apps/staff-alerts/web-push'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const actor = await authorizedManagerStrictFromRequest(req)
  if (!mayEnrol(actor)) return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })

  // Same shared push-service allowlist as enrolment and as sendPush itself.
  const parsed = z.object({
    endpoint: z.string().trim().max(MAX_ENDPOINT_LENGTH).refine(isAllowedPushEndpoint, 'Unsupported push endpoint.'),
  }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'That subscription could not be read.' }, { status: 400 })

  const sub = await findSubscription(parsed.data.endpoint)
  // One indistinguishable answer for "no such device" and "not yours", so a manager cannot probe
  // which endpoints belong to a colleague.
  if (!sub || sub.disabledAt || sub.employeeKey !== actor.key) {
    return NextResponse.json({ ok: false, error: 'This device is not enrolled.' }, { status: 404 })
  }

  const outcome = await sendTestNotification(sub.id)
  logger.info('staff-alerts', 'test_notification', { employee: actor.key, subscriptionId: sub.id, outcome: outcome.status })

  if (outcome.status === 'sent') return NextResponse.json({ ok: true, message: 'Sent — it should appear on this device in a few seconds.' })
  if (outcome.status === 'not_configured') return NextResponse.json({ ok: false, error: 'Push notifications are not configured on the server yet.' }, { status: 503 })
  if (outcome.status === 'expired') return NextResponse.json({ ok: false, error: 'This device’s subscription has expired. Turn notifications off and on again.' }, { status: 409 })
  return NextResponse.json({ ok: false, error: `The push service did not accept it (${outcome.error}).` }, { status: 502 })
}

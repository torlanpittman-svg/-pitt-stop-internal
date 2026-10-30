/**
 * QUICK oil-change sticker printing (the homepage entry) — no job, customer, or vehicle involved.
 * Non-financial: no QuickBooks, no money, nothing that can block finishing a job.
 *
 * GET  — what the form needs to open: who is signed in, interval prefills, today, printer link.
 * POST — accept ONE sticker request and queue it. Body:
 *        { requestId, mileage, intervalMiles?, intervalMonths?, nextMileage?, nextDate? }
 *        `requestId` is the client's idempotency token AND the print job's primary key: re-sending
 *        it reports the original outcome instead of printing a second sticker, permanently.
 *
 * AUTH: every signed-in staff member may print one, but the handler re-verifies the signed session
 * itself (authenticatedActorFromRequest) and fails closed — these paths are not in proxy.ts's
 * matcher, exactly like the job-sticker routes, so the handler IS the gate. The actor is also the
 * owner of the request: nobody can read back or re-accept someone else's quick sticker.
 *
 * NUMBERS ARE NOT COERCED HERE. A decimal mileage is handed to validation as the decimal it is and
 * refused, rather than quietly truncated into a sticker nobody asked for. The only shaping this
 * route does is "absent/not a number → null", which the validator then judges.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { StickerValidationError } from '@/apps/stickers/service'
import { quickStickerBootstrap, queueQuickStickerPrint } from '@/apps/stickers/quick'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Validation failures are explicit and quotable; anything else is logged and reported generically
 *  (an internal message could carry SQL or connection detail). */
function errorResponse(e: unknown, event: string) {
  if (e instanceof StickerValidationError) {
    const status = e.code === 'job_not_found' ? 404 : e.code === 'request_id_conflict' ? 409 : 422
    return NextResponse.json({ error: e.code, message: e.message }, { status })
  }
  logger.error('stickers', event, { error: String((e as Error)?.message ?? e) })
  return NextResponse.json({ error: 'server_error', message: 'Something went wrong on the shop server — try again.' }, { status: 500 })
}

/** A finite number as sent, or null. Never rounded: validation decides what is printable. */
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export async function GET(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await quickStickerBootstrap(actor))
  } catch (e) { return errorResponse(e, 'quick.bootstrap_failed') }
}

export async function POST(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let parsed: unknown
  try { parsed = await req.json() } catch { return NextResponse.json({ error: 'invalid_json', message: 'The print request could not be read.' }, { status: 400 }) }
  // null, an array, a string, a number: not a request body. Refuse before touching the queue.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'invalid_body', message: 'The print request could not be read.' }, { status: 400 })
  }
  const body = parsed as Record<string, unknown>

  try {
    return NextResponse.json(await queueQuickStickerPrint({
      requestId: typeof body.requestId === 'string' ? body.requestId : '',
      mileage: numOrNull(body.mileage) ?? -1,
      intervalMiles: numOrNull(body.intervalMiles),
      intervalMonths: numOrNull(body.intervalMonths),
      nextMileage: numOrNull(body.nextMileage),
      nextDate: typeof body.nextDate === 'string' ? body.nextDate : null,
    }, actor))
  } catch (e) { return errorResponse(e, 'quick.queue_failed') }
}

/**
 * GET /api/oil-sticker/status?requestId=… — poll ONE quick sticker request.
 *
 * Reflects sticker-job expiry first (never a check job: checks reconcile their own queue), so a
 * stale "queued" is reported as expired rather than surprising the shop by printing when the
 * computer reconnects. Answers 404 for anything that is not this actor's own quick sticker —
 * including a check job or an order's sticker job that happens to carry the same id.
 *
 * This is the route the client calls FIRST after a request whose dispatch is uncertain (a dropped
 * network response). It never prints anything.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { StickerValidationError } from '@/apps/stickers/service'
import { quickStickerJobStatus } from '@/apps/stickers/quick'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const requestId = new URL(req.url).searchParams.get('requestId')
  if (!requestId) return NextResponse.json({ error: 'requestId_required' }, { status: 400 })
  try {
    return NextResponse.json(await quickStickerJobStatus(requestId, actor))
  } catch (e) {
    if (e instanceof StickerValidationError) {
      const status = e.code === 'bad_request_id' ? 422 : 404
      return NextResponse.json({ error: e.code, message: e.message }, { status })
    }
    // Never echo an internal failure back to the shop floor — it can carry SQL/connection detail.
    logger.error('stickers', 'quick.status_failed', { error: String((e as Error)?.message ?? e) })
    return NextResponse.json({ error: 'server_error', message: 'Something went wrong on the shop server — try again.' }, { status: 500 })
  }
}

/**
 * GET /api/workflow/orders/[id]/oil-sticker/status?jobId=… — poll a sticker print job.
 * Reflects queue expiry first, so a stale "queued" is reported as expired instead of
 * surprising the shop by printing when the computer reconnects.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { stickerJobStatus, StickerValidationError } from '@/apps/stickers/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const jobId = new URL(req.url).searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'jobId_required' }, { status: 400 })
  try {
    return NextResponse.json(await stickerJobStatus(id, jobId))
  } catch (e) {
    if (e instanceof StickerValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: 404 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}

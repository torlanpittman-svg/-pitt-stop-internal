/**
 * Oil-change sticker printing for a job. Any signed-in employee may use it (non-financial:
 * no QuickBooks, no money, never blocks completing the job).
 *
 * GET  — prefill for the sticker form: vehicle info, the vehicle's last sticker, interval
 *        defaults, label-printer bridge status, and any active/last print job.
 * POST — record a sticker and queue it to the shop label printer.
 *        Body { mileage, intervalMiles?, intervalMonths?, nextMileage?, nextDate? }
 *        or   { reprintStickerId } for an explicit reprint of an existing sticker.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { stickerPrefill, queueStickerPrint, reprintSticker, StickerValidationError, type StickerPrintInput } from '@/apps/stickers/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorResponse(e: unknown) {
  if (e instanceof StickerValidationError) {
    const status = e.code === 'not_found' ? 404 : 422
    return NextResponse.json({ error: e.code, message: e.message }, { status })
  }
  return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  try {
    return NextResponse.json(await stickerPrefill(id))
  } catch (e) { return errorResponse(e) }
}

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  try {
    if (typeof body.reprintStickerId === 'string') {
      return NextResponse.json(await reprintSticker(id, body.reprintStickerId, actor))
    }
    const input: StickerPrintInput = {
      mileage: intOrNull(body.mileage) ?? -1,
      intervalMiles: intOrNull(body.intervalMiles),
      intervalMonths: intOrNull(body.intervalMonths),
      nextMileage: intOrNull(body.nextMileage),
      nextDate: typeof body.nextDate === 'string' ? body.nextDate : null,
    }
    return NextResponse.json(await queueStickerPrint(id, input, actor))
  } catch (e) { return errorResponse(e) }
}

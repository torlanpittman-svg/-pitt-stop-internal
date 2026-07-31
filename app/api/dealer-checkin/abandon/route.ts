/**
 * POST /api/dealer-checkin/abandon  { photoUrl }
 *
 * Best-effort cleanup when an operator backs out / starts over before confirming.
 * Deletes the orphaned tag image uploaded during OCR — but ONLY if it is one of
 * our dealer-checkin Vercel Blob images AND no scan row references it. Never
 * errors the UI (the caller fires this and forgets). No QuickBooks interaction.
 */
import { NextResponse } from 'next/server'
import { deletePhoto } from '@/platform/blob'
import { photoUrlInUse } from '@/apps/dealer-checkin/db'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const { photoUrl } = (await req.json().catch(() => ({}))) as { photoUrl?: string }
    if (!photoUrl || !/\.public\.blob\.vercel-storage\.com\/dealer-checkin\//.test(photoUrl)) {
      return NextResponse.json({ ok: true, deleted: false })
    }
    if (await photoUrlInUse(photoUrl)) return NextResponse.json({ ok: true, deleted: false, reason: 'in_use' })
    await deletePhoto(photoUrl)
    return NextResponse.json({ ok: true, deleted: true })
  } catch (err) {
    logger.warn('dealer-checkin:abandon', 'failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: true, deleted: false }) // best-effort — never surface an error
  }
}

/**
 * POST /api/dealer-checkin/mark-reviewed?id=<scanId>
 * Admin action (Scan History): mark a scan's invoice reviewed and delete its
 * stored tag image now. Idempotent. Called from the basic-auth'd /admin pages.
 */
import { NextResponse } from 'next/server'
import { reviewScanImage } from '@/apps/dealer-checkin/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'pass ?id=' }, { status: 400 })
  const result = await reviewScanImage(id)
  return NextResponse.json(result, { status: result.ok ? 200 : 404 })
}

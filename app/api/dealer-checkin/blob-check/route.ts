/**
 * GET /api/dealer-checkin/blob-check  — TEMPORARY diagnostic.
 * Verifies the Vercel Blob upload path. Reports token PRESENCE (boolean, never
 * the value) and the exact upload error if any. Remove after verification.
 */
import { NextResponse } from 'next/server'
import { uploadPhoto } from '@/platform/blob'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const hasToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN)
  try {
    const url = await uploadPhoto('dealer-checkin/_healthcheck', `hc-${Date.now()}.txt`, Buffer.from('ok'), 'text/plain')
    return NextResponse.json({ ok: true, hasToken, url })
  } catch (err) {
    return NextResponse.json({ ok: false, hasToken, error: err instanceof Error ? err.message : String(err) })
  }
}

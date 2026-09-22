import { NextResponse } from 'next/server'
import { receiptUploaderFromRequest } from '@/apps/expenses/authz'
import { extractSavedReceipt } from '@/apps/expenses/extract-saved'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Retry/resume uses the saved private image; new uploads read their bytes in the upload request. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const uploader = await receiptUploaderFromRequest(req)
  if (!uploader) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { token?: string }
  return extractSavedReceipt(id, uploader, body.token)
}

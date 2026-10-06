/**
 * POST /api/twilio/sms/status — Twilio delivery status callback (PUBLIC, signature-gated). Updates the
 * matching recipient's delivery_status/error_code by provider message id so failures are visible.
 */
import { NextResponse } from 'next/server'
import { validateTwilioSignature } from '@/apps/marketing/providers/twilio'
import { handleStatusCallback } from '@/apps/marketing/twilio-webhook'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function webhookUrl(req: Request, path: string): string {
  const base = process.env.TWILIO_WEBHOOK_BASE_URL
  if (base) return `${base.replace(/\/$/, '')}${path}`
  const h = new Headers(req.headers)
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? ''
  return `${proto}://${host}${path}`
}

export async function POST(req: Request) {
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!token) return NextResponse.json({ ok: false, error: 'sms_not_configured' }, { status: 503 })

  const form = await req.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const sig = req.headers.get('x-twilio-signature')
  if (!validateTwilioSignature(token, webhookUrl(req, '/api/twilio/sms/status'), params, sig)) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 403 })
  }

  try {
    const result = await handleStatusCallback(params)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    logger.error('twilio:status', 'failed', { error: String(err) })
    return NextResponse.json({ ok: false }, { status: 200 })
  }
}

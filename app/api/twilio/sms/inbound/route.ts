/**
 * POST /api/twilio/sms/inbound — Twilio inbound SMS webhook (PUBLIC, signature-gated; intentionally
 * outside the proxy's /api/marketing gate so Twilio can reach it). Validates X-Twilio-Signature with
 * the auth token, then applies STOP/START/HELP + routes normal replies into the conversation queue.
 */
import { NextResponse } from 'next/server'
import { validateTwilioSignature } from '@/apps/marketing/providers/twilio'
import { handleInboundSms, twiml } from '@/apps/marketing/twilio-webhook'
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
  if (!validateTwilioSignature(token, webhookUrl(req, '/api/twilio/sms/inbound'), params, sig)) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 403 })
  }

  try {
    const result = await handleInboundSms(params)
    logger.info('twilio:inbound', 'handled', { action: result.action, matched: !!result.customerId })
    return new NextResponse(twiml(result.reply), { status: 200, headers: { 'content-type': 'text/xml' } })
  } catch (err) {
    logger.error('twilio:inbound', 'failed', { error: String(err) })
    // Return empty TwiML (200) so Twilio doesn't retry-storm; the error is logged.
    return new NextResponse(twiml(null), { status: 200, headers: { 'content-type': 'text/xml' } })
  }
}

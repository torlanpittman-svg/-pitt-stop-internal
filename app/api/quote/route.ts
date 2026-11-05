/**
 * POST /api/quote — public quote request (ceramic / headliner / other). No auth: customers use it from the
 * website and the booking host. Honeypot + strict validation; the lead row is always saved, the email to the
 * shop inbox is attempted once, and the response says truthfully whether Postmark accepted it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { parseQuoteRequest, submitQuoteRequest } from '@/apps/marketing/quote-request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 }) }
  if (!body || typeof body !== 'object') return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  if (typeof body.website === 'string' && body.website.trim()) return NextResponse.json({ ok: false, error: 'Unable to send. Please call the shop.' }, { status: 400 })
  const parsed = parseQuoteRequest(body)
  if (!parsed.ok) return NextResponse.json({ ok: false, errors: parsed.errors }, { status: 400 })
  try {
    const r = await submitQuoteRequest(parsed.req, body.attribution)
    if (r.emailed !== 'sent') console.error('[quote] lead saved but email not sent:', r.emailed, r.error ?? '')
    return NextResponse.json({ ok: true, emailed: r.emailed === 'sent', leadId: r.leadId })
  } catch (e) {
    console.error('[quote] failed:', e)
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please call the shop.' }, { status: 500 })
  }
}

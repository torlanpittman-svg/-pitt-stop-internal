/**
 * POST /api/quote — public quote request (ceramic / headliner / other). No auth: customers use it from the
 * website and the booking host. Honeypot + strict validation. The body's `requestKey` makes the request
 * idempotent: a network retry or double-tap replays the stored outcome (one lead, at most one accepted
 * email) instead of submitting twice. The lead row is always saved before any email attempt, photos are
 * persisted with the request, and the response says truthfully whether Postmark accepted the send.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { parseQuoteRequest, submitQuoteRequest, QuoteRequestConflictError, QuoteStillProcessingError } from '@/apps/marketing/quote-request'

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
    const r = await submitQuoteRequest(parsed.req, body.attribution, { requestKey: typeof body.requestKey === 'string' ? body.requestKey : null })
    if (r.emailed !== 'sent') console.error('[quote] lead saved but email not sent:', r.emailed, r.error ?? '')
    return NextResponse.json({ ok: true, emailed: r.emailed === 'sent', leadId: r.leadId })
  } catch (e) {
    // `conflict: true` tells the form to mint a fresh key before the user resubmits the edited request.
    if (e instanceof QuoteRequestConflictError) return NextResponse.json({ ok: false, conflict: true, error: 'This looks like a changed request — please press "Request my quote" again.' }, { status: 409 })
    // An earlier attempt is still working; nothing here says the request was lost.
    if (e instanceof QuoteStillProcessingError) return NextResponse.json({ ok: false, error: 'We’re already working on this request. Give it a few seconds and try again, or call the shop.' }, { status: 409 })
    console.error('[quote] failed:', e)
    return NextResponse.json({ ok: false, error: 'Something went wrong. Please call the shop.' }, { status: 500 })
  }
}

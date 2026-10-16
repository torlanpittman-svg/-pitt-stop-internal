/**
 * POST /api/checks/resolve-payee — READ-ONLY preview of how a typed payee resolves in QuickBooks across
 * Vendors, Employees and Customers: existing payee (use), not in QuickBooks (create a vendor after
 * confirmation), ambiguous (pick one), or blocked (the name is taken by a record a check can't use).
 * A failed lookup is reported as a failure — never as "not found". No QuickBooks mutation. Manager-only.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { previewPayee, PayeeLookupError } from '@/apps/checks/payee'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  let body: { payeeName?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  const name = String(body.payeeName ?? '').trim()
  if (!name) return NextResponse.json({ error: 'payee_required' }, { status: 400 })
  try {
    return NextResponse.json(await previewPayee(name))
  } catch (e) {
    const message = e instanceof PayeeLookupError ? e.message : 'Could not look up this payee in QuickBooks. Nothing was recorded — try again in a moment.'
    return NextResponse.json({ error: 'payee_lookup_failed', message }, { status: 502 })
  }
}

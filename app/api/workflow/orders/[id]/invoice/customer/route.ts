/**
 * Retail QuickBooks customer disambiguation for a Job. Manager/admin only (server-enforced),
 * gated by the same retail_qb_enabled flag as Create.
 *
 *   GET  → READ-ONLY candidate QB customers this Job's contact matches (by exact email / name),
 *          for the manager picker surfaced when Create hits an ambiguous match.
 *   POST { qbCustomerId } → persist the manager's chosen QB CustomerRef onto the Pitt Stop
 *          customer directory so every future invoice resolves via directory-cache (no more
 *          email ambiguity). Never creates/renames/merges a QB customer; refused once an invoice
 *          already exists. Create is run separately afterwards.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { retailQbEnabled } from '@/apps/settings/db'
import { listRetailCustomerCandidates, setRetailCustomerChoice } from '@/apps/quickbooks/retail-invoice-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  if (!(await retailQbEnabled())) {
    return NextResponse.json({ ok: false, error: 'Retail QuickBooks invoicing is disabled.' }, { status: 503 })
  }
  const result = await listRetailCustomerCandidates(id)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  if (!(await retailQbEnabled())) {
    return NextResponse.json({ ok: false, error: 'Retail QuickBooks invoicing is disabled.' }, { status: 503 })
  }
  const body = await req.json().catch(() => ({})) as { qbCustomerId?: string }
  const result = await setRetailCustomerChoice({ orderId: id, qbCustomerId: body?.qbCustomerId ?? '', actor: actor.name })
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}

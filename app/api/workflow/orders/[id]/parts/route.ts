import { NextResponse } from 'next/server'
import { employeeAuthorizedFromRequest, shopActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { partsVisibleFor } from '@/apps/parts/visibility'
import {
  listPartsForOrder,
  addPart,
  updatePart,
  markOrdered,
  receivePart,
  recordReturn,
  cancelPart,
  billPart,
  type Part,
} from '@/apps/parts/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Hide manager-only pricing/credit fields from employees (mirrors invoice gating). */
function redact(parts: Part[], manager: boolean): Part[] {
  if (manager) return parts
  return parts.map((p) => ({ ...p, unitCostCents: null, sellPriceCents: null, coreCreditCents: null, returnCreditCents: null }))
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Gate on a VALID employee session (individual OR legacy shared-PIN), matching every other shop tool.
  // A shared-PIN session is anonymous (no resolved actor) but still authorized — treat it as an employee.
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  }
  const { id } = await params
  const actor = await shopActorFromRequest(req)
  const manager = isManagerRole(actor?.role)
  // Reversible rollout gate: until parts ships to employees, a non-manager sees nothing (data is
  // preserved in the DB, just not surfaced). Managers/admins always see it so they can test.
  if (!partsVisibleFor(manager)) {
    return NextResponse.json({ ok: true, parts: [], manager: false, visible: false })
  }
  const parts = await listPartsForOrder(id)
  return NextResponse.json({ ok: true, parts: redact(parts, manager), manager, visible: true })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Same gate as GET: any valid employee session may record parts. Manager-only fields/actions (cost,
  // sell price, credits, bill-to-invoice) are enforced below via `manager`, which requires a resolved
  // manager role — an anonymous shared-PIN session is an employee and cannot set or see those.
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  }
  const { id } = await params
  const actor = await shopActorFromRequest(req)
  const manager = isManagerRole(actor?.role)
  const actorName = actor?.name ?? 'Employee'
  // Same rollout gate as GET: while parts are hidden from employees, they cannot mutate them either
  // (keeps a manual-first parts workflow off employees' phones until the permanent flow ships).
  if (!partsVisibleFor(manager)) {
    return NextResponse.json({ ok: false, error: 'Parts are not available yet.' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = String(body.action ?? '')

  // Confirm any referenced part belongs to THIS order before mutating (no cross-order edits).
  const existing = await listPartsForOrder(id)
  const partId = typeof body.partId === 'string' ? body.partId : null
  if (action !== 'add' && (!partId || !existing.some((p) => p.id === partId))) {
    return NextResponse.json({ ok: false, error: 'Part not found on this order.' }, { status: 404 })
  }

  try {
    switch (action) {
      case 'add': {
        const description = String(body.description ?? '').trim()
        if (!description) return NextResponse.json({ ok: false, error: 'A part description is required.' }, { status: 400 })
        await addPart({
          serviceOrderId: id,
          description,
          partNumber: str(body.partNumber),
          brand: str(body.brand),
          supplier: str(body.supplier),
          quantity: posNum(body.quantity, 1),
          unitCostCents: manager ? intOrNull(body.unitCostCents) : null,
          sellPriceCents: manager ? intOrNull(body.sellPriceCents) : null,
          isCore: body.isCore === true,
          notes: str(body.notes),
          actor: actorName,
        })
        break
      }
      case 'update': {
        await updatePart(partId!, {
          description: body.description !== undefined ? String(body.description) : undefined,
          partNumber: body.partNumber !== undefined ? str(body.partNumber) : undefined,
          brand: body.brand !== undefined ? str(body.brand) : undefined,
          supplier: body.supplier !== undefined ? str(body.supplier) : undefined,
          quantity: body.quantity !== undefined ? posNum(body.quantity, 1) : undefined,
          unitCostCents: manager && body.unitCostCents !== undefined ? intOrNull(body.unitCostCents) : undefined,
          sellPriceCents: manager && body.sellPriceCents !== undefined ? intOrNull(body.sellPriceCents) : undefined,
          isCore: body.isCore !== undefined ? body.isCore === true : undefined,
          notes: body.notes !== undefined ? str(body.notes) : undefined,
          actor: actorName,
        })
        break
      }
      case 'mark_ordered': {
        const r = await markOrdered(partId!, {
          supplier: str(body.supplier),
          supplierOrderNumber: str(body.supplierOrderNumber),
          expectedArrival: str(body.expectedArrival),
          actor: actorName,
        })
        if (!r.ok) return NextResponse.json(r, { status: 400 })
        break
      }
      case 'receive': {
        const r = await receivePart(partId!, posNum(body.receiveQuantity, 0), actorName)
        if (!r.ok) return NextResponse.json(r, { status: 400 })
        break
      }
      case 'return': {
        const r = await recordReturn(partId!, {
          returnQty: posNum(body.returnQuantity, 0),
          returnCreditCents: manager ? intOrNull(body.returnCreditCents) : null,
          isCore: body.isCore === true ? true : undefined,
          coreCreditCents: manager ? intOrNull(body.coreCreditCents) : null,
          actor: actorName,
        })
        if (!r.ok) return NextResponse.json(r, { status: 400 })
        break
      }
      case 'cancel': {
        await cancelPart(partId!, actorName)
        break
      }
      case 'bill': {
        if (!manager) return NextResponse.json({ ok: false, error: 'Managers only.' }, { status: 403 })
        const r = await billPart(partId!, actorName)
        if (!r.ok) return NextResponse.json(r, { status: 400 })
        break
      }
      default:
        return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Parts update failed.' }, { status: 500 })
  }

  const parts = await listPartsForOrder(id)
  return NextResponse.json({ ok: true, parts: redact(parts, manager), manager })
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}
function intOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}
function posNum(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * POST /api/admin/checks/sequence — OWNER initializes/resets a bank's physical check-number sequence to
 * the number of the NEXT blank check in the tray. The system never invents a starting number; this is
 * where the owner supplies it. Refuses to LOWER an existing sequence unless force=true. Admin-gated.
 *
 * Body: { bankKey: 'operating'|'auto_sales', startNumber: number, force?: boolean }
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { initCheckSequence } from '@/apps/checks/numbering'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  let body: { bankKey?: string; startNumber?: number; force?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  const bankKey = body.bankKey === 'auto_sales' ? 'auto_sales' : 'operating'
  const startNumber = Number(body.startNumber)
  try {
    const res = await initCheckSequence(bankKey, startNumber, actor.name ?? 'admin', !!body.force)
    return NextResponse.json({ ok: true, bankKey, ...res })
  } catch (e) {
    return NextResponse.json({ error: 'invalid', message: String((e as Error)?.message ?? e) }, { status: 400 })
  }
}

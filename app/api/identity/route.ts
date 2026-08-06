/**
 * GET  /api/identity            → current actor + role + elevation state
 * POST /api/identity {action}   → 'select' | 'elevate' | 'lock'
 *
 * Attribution + manager elevation only. Admin AREA stays behind ADMIN_PASSWORD
 * (proxy.ts) — never unlocked here. PIN hashes are never returned.
 */
import { NextResponse } from 'next/server'
import { getEmployee } from '@/apps/workflow/db'
import {
  getActor, getElevation, effectiveRole, verifyPin, signElevation, elevationMinutes,
  identityEnabled, type Role,
} from '@/apps/workflow/identity'
import { completionEnabled } from '@/apps/workflow/completion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const YEAR = 365 * 24 * 60 * 60

export async function GET(req: Request) {
  const cookie = req.headers.get('cookie')
  const actor = getActor(cookie)
  const elev = getElevation(cookie)
  return NextResponse.json({
    enabled: identityEnabled(),
    actor: actor ? { id: actor.id, name: actor.name, role: actor.role } : null,
    elevated: !!elev && !!actor && elev.employeeId === actor.id,
    elevatedUntil: elev?.exp ?? null,
    effectiveRole: effectiveRole(actor, elev),
    minutes: elevationMinutes(),
    completionEnabled: completionEnabled(),
  })
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; employeeId?: string; pin?: string }
  const action = body.action

  if (action === 'select') {
    if (!body.employeeId) return NextResponse.json({ ok: false, error: 'employeeId required' }, { status: 400 })
    const emp = await getEmployee(body.employeeId)
    if (!emp || !emp.active) return NextResponse.json({ ok: false, error: 'Unknown employee' }, { status: 404 })
    const res = NextResponse.json({ ok: true, actor: { id: emp.id, name: emp.name, role: emp.role } })
    res.cookies.set('ps_actor', JSON.stringify({ id: emp.id, name: emp.name, role: emp.role }),
      { httpOnly: false, sameSite: 'lax', path: '/', maxAge: YEAR })
    res.cookies.set('ps_elev', '', { path: '/', maxAge: 0 })  // switching person drops elevation
    return res
  }

  if (action === 'elevate') {
    const actor = getActor(req.headers.get('cookie'))
    const id = body.employeeId || actor?.id
    if (!id) return NextResponse.json({ ok: false, error: 'No employee selected' }, { status: 400 })
    const emp = await getEmployee(id)
    if (!emp || !emp.active) return NextResponse.json({ ok: false, error: 'Unknown employee' }, { status: 404 })
    if (emp.role !== 'manager' && emp.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'This user is not a manager.' }, { status: 403 })
    }
    if (!verifyPin(body.pin ?? '', emp.pinHash)) {
      return NextResponse.json({ ok: false, error: 'Incorrect PIN.' }, { status: 401 })
    }
    const exp = Date.now() + elevationMinutes() * 60_000
    const token = signElevation({ employeeId: emp.id, role: emp.role as Role, exp })
    const res = NextResponse.json({ ok: true, elevatedUntil: exp, role: emp.role })
    res.cookies.set('ps_elev', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: elevationMinutes() * 60 })
    return res
  }

  if (action === 'lock') {
    const res = NextResponse.json({ ok: true })
    res.cookies.set('ps_elev', '', { path: '/', maxAge: 0 })
    return res
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
}

/**
 * GET /api/identity → the authenticated actor + role for app-side visibility (drives which manager
 *                     controls the Job detail / Work Board show). Derived from the SIGNED ps_emp
 *                     session (server-verified), never a client-writable cookie.
 * POST /api/identity {action} → 'signout' clears any legacy attribution cookies. 'select'/'elevate'
 *                     are retired: identity + role now come from the PIN at sign-in, so a client can
 *                     no longer choose who it is or self-elevate. Sign out via DELETE
 *                     /api/auto-sales/session (clears the signed session).
 *
 * Admin AREA (/admin/*) stays behind ADMIN_PASSWORD (proxy.ts) — never unlocked here.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { identityEnabled } from '@/apps/workflow/identity'
import { completionEnabled } from '@/apps/workflow/completion'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { completionInvoiceEnabled } from '@/apps/settings/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  return NextResponse.json({
    enabled: identityEnabled(),
    actor: actor ? { id: actor.key, name: actor.name, role: actor.role } : null,
    elevated: false,
    elevatedUntil: null,
    effectiveRole: actor?.role ?? 'employee',
    minutes: 0,
    completionEnabled: completionEnabled(),
    estimateEnabled: estimateEnabled(),
    completionInvoiceEnabled: await completionInvoiceEnabled(),
  })
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string }

  if (body.action === 'signout') {
    // Clear legacy attribution cookies. The authoritative sign-out (signed session) is
    // DELETE /api/auto-sales/session.
    const res = NextResponse.json({ ok: true })
    res.cookies.set('ps_actor', '', { path: '/', maxAge: 0 })
    res.cookies.set('ps_elev', '', { path: '/', maxAge: 0 })
    return res
  }

  // 'select' / 'elevate' are retired — identity + role are established by the PIN at sign-in and
  // proven by the signed session. A client may not choose an identity or self-elevate.
  return NextResponse.json({ ok: false, error: 'Identity is set by your PIN at sign-in.' }, { status: 410 })
}

/**
 * GET /api/quick-entry/service-search?q=...  — retail "Other" service suggestions grounded in real
 * Pitt Stop history (name + robust historical price). Employee-session gated (proxy.ts covers
 * /api/quick-entry/*) with a defense-in-depth re-check so an unauthenticated caller can never use it.
 * No AI — pure DB read + in-memory match; the client debounces so this is not hit per keystroke.
 */
import { NextResponse } from 'next/server'
import { searchRetailServices } from '@/apps/quick-entry/jobs-db'
import { employeeAuthorizedFromRequest } from '@/apps/auth/employee-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  }
  const q = new URL(req.url).searchParams.get('q') ?? ''
  if (q.trim().length < 2) return NextResponse.json({ ok: true, matches: [] })
  try {
    const matches = await searchRetailServices(q)
    return NextResponse.json({ ok: true, matches })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

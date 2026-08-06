/**
 * GET /api/production?date=YYYY-MM-DD  → Daily Production Log (count-once).
 * Manager-elevation-gated (managers/admins only). Not accounting/admin — it's an
 * operational production report.
 */
import { NextResponse } from 'next/server'
import { parseActor, verifyElevation, effectiveRole } from '@/apps/workflow/identity'
import { completionEnabled } from '@/apps/workflow/completion'
import { dailyProduction, shopToday } from '@/apps/workflow/production'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function readValue(cookieHeader: string | null, name: string): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
}

export async function GET(req: Request) {
  if (!completionEnabled()) return NextResponse.json({ ok: false, error: 'not enabled' }, { status: 404 })
  const cookie = req.headers.get('cookie')
  const role = effectiveRole(parseActor(readValue(cookie, 'ps_actor')), verifyElevation(readValue(cookie, 'ps_elev')))
  if (role !== 'manager' && role !== 'admin') {
    return NextResponse.json({ ok: false, error: 'Manager access required.' }, { status: 403 })
  }
  const date = new URL(req.url).searchParams.get('date') || shopToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: 'bad date' }, { status: 400 })
  const data = await dailyProduction(date)
  return NextResponse.json({ ok: true, ...data })
}

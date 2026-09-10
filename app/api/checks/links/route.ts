/**
 * /api/checks/links?kind=job|vehicle — compact, manager-gated lookups for the Write-a-Check pickers.
 *   job     → current Work Board service orders (Customer Job attribution)
 *   vehicle → Auto Sales inventory vehicles (Auto Sales attribution — off operating CFO)
 *
 * Read-only; returns only display labels/ids, never accounting or bank data.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { listLinkableJobs, listLinkableVehicles } from '@/apps/checks/links'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const kind = new URL(req.url).searchParams.get('kind')
  if (kind === 'job') return NextResponse.json({ options: await listLinkableJobs() })
  if (kind === 'vehicle') return NextResponse.json({ options: await listLinkableVehicles() })
  return NextResponse.json({ error: 'bad_kind', message: 'kind must be job|vehicle' }, { status: 400 })
}

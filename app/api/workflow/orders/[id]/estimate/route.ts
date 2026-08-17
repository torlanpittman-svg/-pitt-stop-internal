/**
 * Job Estimate API (Phase 3) — manager/admin only, estimate-only (no QB/AutoLeap).
 * GET  → full estimate (or { estimate: null }).
 * POST → action dispatch (build, services, lines, tax, status, approval, convert).
 */
import { NextResponse } from 'next/server'
import { parseActor, baseRole } from '@/apps/workflow/identity'
import { estimateEnabled } from '@/apps/workflow/estimate'
import {
  getOrCreateEstimate, getEstimateRow, getFullEstimate, promoteTextServices, recomputeEstimate,
  addService, updateService, removeService, addLine, updateLine, removeLine,
  setTaxRate, setStatus, setApproval, convertEstimate, type LineInput,
  prepareEstimateView, getEstimateView, setServicePrice, setWorkTotal, itemizeEstimate, flagQbSyncNeededIfInvoiced,
} from '@/apps/workflow/estimate-db'
import type { ApprovalState, EstimateStatus } from '@/apps/workflow/estimate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function actorFrom(req: Request) {
  const cookie = req.headers.get('cookie') ?? ''
  const m = cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith('ps_actor='))
  return parseActor(m ? decodeURIComponent(m.slice('ps_actor='.length)) : null)
}
function guard(req: Request): { ok: true; name: string | null } | { ok: false; res: NextResponse } {
  if (!estimateEnabled()) return { ok: false, res: NextResponse.json({ ok: false, error: 'not enabled' }, { status: 404 }) }
  const actor = actorFrom(req)
  if (baseRole(actor) !== 'manager' && baseRole(actor) !== 'admin') {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Manager access required.' }, { status: 403 }) }
  }
  return { ok: true, name: actor?.name ?? null }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = guard(req); if (!g.ok) return g.res
  const { id } = await params
  // Simplified mobile view (title + price + Work Total). Raw estimate/services also
  // included for the future richer desktop view over the same record.
  const [view, full] = await Promise.all([getEstimateView(id), getFullEstimate(id)])
  return NextResponse.json({ ok: true, view, ...(full ?? { estimate: null, services: [] }) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = guard(req); if (!g.ok) return g.res
  const { id } = await params
  const actor = g.name
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = body.action as string

  try {
    const estimateId = async () => (await getEstimateRow(id))?.id ?? (await getOrCreateEstimate(id, actor)).id

    switch (action) {
      case 'build':
      case 'prepare': {
        // Idempotent page entry: ensure estimate, mirror services, seed a fresh Job.
        return NextResponse.json({ ok: true, view: await prepareEstimateView(id, actor) })
      }
      case 'set_service_price': {
        const eid = await estimateId()
        await setServicePrice(eid, String(body.serviceId), Math.max(0, Math.round(Number(body.cents) || 0)), actor)
        await flagQbSyncNeededIfInvoiced(id, 'a price changed')
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'set_work_total': {
        const eid = await estimateId()
        await setWorkTotal(eid, Math.max(0, Math.round(Number(body.cents) || 0)), actor)
        await flagQbSyncNeededIfInvoiced(id, 'the Work Total changed')
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'itemize': {
        await itemizeEstimate(await estimateId(), actor)
        await flagQbSyncNeededIfInvoiced(id, 'pricing changed')
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'add_service': {
        // Custom service (optionally with a price). A priced add itemizes; a name-only add
        // on a flat Job leaves it flat.
        const eid = await estimateId()
        const svc = await addService(eid, String(body.title ?? '').trim() || 'Service')
        if (body.cents != null) await setServicePrice(eid, svc.id, Math.max(0, Math.round(Number(body.cents) || 0)), actor)
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'update_service':  await updateService(String(body.serviceId), body.patch as Record<string, never>); break
      case 'remove_service':  await removeService(String(body.serviceId)); await recomputeEstimate(await estimateId()); break
      case 'add_line':        await addLine(String(body.serviceId), body.line as LineInput); await recomputeEstimate(await estimateId()); break
      case 'update_line':     await updateLine(String(body.lineId), body.patch as Record<string, never>); await recomputeEstimate(await estimateId()); break
      case 'remove_line':     await removeLine(String(body.lineId)); await recomputeEstimate(await estimateId()); break
      case 'set_tax':         await setTaxRate(await estimateId(), Number(body.bps)); await recomputeEstimate(await estimateId()); break
      case 'set_status':      await setStatus(await estimateId(), id, body.status as EstimateStatus, actor); break
      case 'set_approval':    await setApproval(await estimateId(), id, String(body.serviceId), body.state as ApprovalState, actor); break
      case 'convert': {
        const r = await convertEstimate(await estimateId(), id, actor)
        return NextResponse.json({ ok: true, synced: r.synced, ...(await getFullEstimate(id)) })
      }
      default:
        return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, view: await getEstimateView(id), ...(await getFullEstimate(id)) })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

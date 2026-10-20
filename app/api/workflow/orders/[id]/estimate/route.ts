/**
 * Job Estimate API (Phase 3) — manager/admin only, estimate-only (no QB/AutoLeap).
 * GET  → full estimate (or { estimate: null }).
 * POST → action dispatch (build, services, lines, tax, status, approval, convert).
 */
import { getOrderWithContext } from '@/apps/workflow/db'
import { withIntakeLock } from '@/apps/estimates/db'
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { estimateEnabled } from '@/apps/workflow/estimate'
import {
  getOrCreateEstimate, getEstimateRow, getFullEstimate, recomputeEstimate,
  addService, updateService, removeEstimateService, addLine, updateLine, removeLine,
  setTaxRate, setStatus, setApproval, convertEstimate, type LineInput,
  prepareEstimateView, getEstimateView, setServicePrice, setWorkTotal, itemizeEstimate, acceptItemizedTotal, flagQbSyncNeededIfInvoiced, renameService,
  selectServiceMatch, setServiceDetail, toMatchMethod,
} from '@/apps/workflow/estimate-db'
import { interpretServiceEntry, listCatalogChoices } from '@/apps/quick-entry/service-match-db'
import { listShortcuts, approveAlias } from '@/apps/quick-entry/shortcuts'
import { addEstimatePart, updateEstimatePart, removeEstimatePartWithLabor, decidePartLabor, addTireWork, convertServiceToPart, clarifyServiceWithPart, type LaborAction } from '@/apps/parts/estimate-parts'
import { assertEstimateReady } from '@/apps/workflow/estimate-review'
import type { ApprovalState, EstimateStatus } from '@/apps/workflow/estimate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function guard(req: Request): Promise<{ ok: true; name: string | null; role: string } | { ok: false; res: NextResponse }> {
  if (!estimateEnabled()) return { ok: false, res: NextResponse.json({ ok: false, error: 'not enabled' }, { status: 404 }) }
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Manager access required.' }, { status: 403 }) }
  }
  return { ok: true, name: actor.name, role: actor.role }
}

/** Optional "remember this wording" (manager-approved alternate name). Never fails the save itself. */
async function maybeRememberAlias(body: Record<string, unknown>, actor: string | null): Promise<string | null> {
  if (body.rememberAlias !== true || typeof body.catalogId !== 'string' || !body.catalogId) return null
  try { await approveAlias(body.catalogId, String(body.aliasText ?? body.entryText ?? ''), actor); return null }
  catch (e) { return e instanceof Error ? e.message : 'Could not remember that wording.' }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req); if (!g.ok) return g.res
  const { id } = await params
  // Simplified mobile view (title + price + Work Total). Raw estimate/services also
  // included for the future richer desktop view over the same record.
  const [view, full] = await Promise.all([getEstimateView(id), getFullEstimate(id)])
  return NextResponse.json({ ok: true, view, ...(full ?? { estimate: null, services: [] }) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req); if (!g.ok) return g.res
  const { id } = await params
  const actor = g.name
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = body.action as string

  try {
    const estimateId = async () => (await getEstimateRow(id))?.id ?? (await getOrCreateEstimate(id, actor)).id

    const perform = async () => {
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
      case 'accept_total': {
        // Manager accepts a complete itemized breakdown whose sum differs from the agreed reference.
        await acceptItemizedTotal(await estimateId(), actor)
        await flagQbSyncNeededIfInvoiced(id, 'the itemized total was accepted')
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'interpret': {
        // Read-only: understand the wording and propose real catalog items. Nothing is saved.
        const entry = String(body.entry ?? '').slice(0, 300)
        return NextResponse.json({ ok: true, ...(await interpretServiceEntry(entry)) })
      }
      case 'catalog_list': {
        const [catalog, shortcuts] = await Promise.all([listCatalogChoices(), listShortcuts().catch(() => [])])
        return NextResponse.json({ ok: true, catalog, shortcuts })
      }
      case 'add_service': {
        // A confirmed catalog choice (picker / shortcut / suggestion), an explicit custom service, or
        // (older clients) a bare title. A priced add itemizes; a name-only add on a flat Job stays flat.
        // Matching never sets a price: only an explicitly entered amount is saved.
        const eid = await estimateId()
        const svc = await addService(eid, String(body.title ?? '').trim() || 'Service', {
          catalogId: typeof body.catalogId === 'string' && body.catalogId ? body.catalogId : null,
          custom: body.custom === true, detail: body.detail as string | null | undefined,
          matchMethod: toMatchMethod(body.matchMethod, 'manual'), entryText: typeof body.entryText === 'string' ? body.entryText : null, actor,
        })
        if (body.cents != null) await setServicePrice(eid, svc.id, Math.max(0, Math.round(Number(body.cents) || 0)), actor)
        else await recomputeEstimate(eid)
        const aliasError = await maybeRememberAlias(body, actor)
        await flagQbSyncNeededIfInvoiced(id, 'a service was added')
        return NextResponse.json({ ok: true, aliasError, view: await getEstimateView(id) })
      }
      case 'select_match': {
        // Correct a wrong match (or resolve an unmatched/odor line). Price, qty, tax untouched.
        await selectServiceMatch(id, String(body.serviceId), {
          catalogId: typeof body.catalogId === 'string' && body.catalogId ? body.catalogId : null, custom: body.custom === true,
          detail: body.detail as string | null | undefined, title: typeof body.title === 'string' ? body.title : null,
          matchMethod: toMatchMethod(body.matchMethod, 'manual'),
        }, actor)
        const aliasError = await maybeRememberAlias(body, actor)
        await flagQbSyncNeededIfInvoiced(id, 'a service match changed')
        return NextResponse.json({ ok: true, aliasError, view: await getEstimateView(id) })
      }
      case 'set_detail': {
        await setServiceDetail(id, String(body.serviceId), body.detail, actor)
        await flagQbSyncNeededIfInvoiced(id, 'a service detail changed')
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'add_part': {
        const p = (body.part ?? {}) as Record<string, unknown>
        const part = await addEstimatePart(id, {
          description: String(p.description ?? ''), supply: p.supply === 'customer' ? 'customer' : 'shop',
          fitment: p.fitment as string | null, partNumber: p.partNumber as string | null, supplier: p.supplier as string | null,
          quantity: p.quantity as number | null, unitCostCents: p.unitCostCents as number | null, sellPriceCents: p.sellPriceCents as number | null,
          entryText: typeof p.entryText === 'string' ? p.entryText : null,
        }, actor)
        return NextResponse.json({ ok: true, partId: part.id, view: await getEstimateView(id) })
      }
      case 'update_part': {
        await updateEstimatePart(id, String(body.partId), (body.patch ?? {}) as never, actor)
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'remove_part': {
        // labor: { action: 'keep' } | { action: 'remove', serviceId } — what happens to the part's linked installation labor.
        const lab = body.labor as { action?: unknown; serviceId?: unknown } | undefined
        await removeEstimatePartWithLabor(id, String(body.partId),
          lab?.action === 'remove' && typeof lab.serviceId === 'string' ? { action: 'remove', serviceId: lab.serviceId } : { action: 'keep' }, actor)
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'part_labor': {
        await decidePartLabor(id, String(body.partId), (body.labor ?? {}) as LaborAction, actor, g.role)
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'convert_to_part': {
        // A part saved as a service line → a real part (same row + price line; price/qty/tax untouched).
        const p = (body.part ?? {}) as Record<string, unknown>
        await convertServiceToPart(id, String(body.serviceId), {
          fitment: p.fitment as string | null, partNumber: p.partNumber as string | null, supplier: p.supplier as string | null,
          confirmed: body.confirmed === true,
        }, actor)
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'clarify_part': {
        // Keep this line as the work (price untouched) and add the part separately, linked as its labor.
        const p = (body.part ?? {}) as Record<string, unknown>
        await clarifyServiceWithPart(id, String(body.serviceId), {
          description: String(p.description ?? ''), supply: p.supply === 'customer' ? 'customer' : 'shop',
          fitment: p.fitment as string | null, partNumber: p.partNumber as string | null, supplier: p.supplier as string | null,
          quantity: p.quantity as number | null, unitCostCents: p.unitCostCents as number | null, sellPriceCents: p.sellPriceCents as number | null,
        }, actor, g.role)
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'add_tires': {
        await addTireWork(id, (body.tires ?? {}) as never, actor, g.role)
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'rename_service': {
        // Label correction only — price line, qty, and tax flags are untouched.
        await renameService(id, String(body.serviceId), String(body.title ?? ''), actor)
        await flagQbSyncNeededIfInvoiced(id, 'a service name changed')
        return NextResponse.json({ ok: true, view: await getEstimateView(id) })
      }
      case 'update_service':  await updateService(String(body.serviceId), body.patch as Record<string, never>); break
      case 'remove_service': {
        // Durable removal: also drops the Job's text entry so reopening can't re-promote it.
        const removed = await removeEstimateService(id, String(body.serviceId), actor)
        return NextResponse.json({ ok: true, removed, view: await getEstimateView(id) })
      }
      case 'add_line':        await addLine(String(body.serviceId), body.line as LineInput); await recomputeEstimate(await estimateId()); break
      case 'update_line':     await updateLine(String(body.lineId), body.patch as Record<string, never>); await recomputeEstimate(await estimateId()); break
      case 'remove_line':     await removeLine(String(body.lineId)); await recomputeEstimate(await estimateId()); break
      case 'set_tax':         await setTaxRate(await estimateId(), Number(body.bps)); await recomputeEstimate(await estimateId()); break
      case 'set_status':
        // Marking an estimate sent requires parts labor review / odor checks to be resolved first.
        if (body.status === 'sent') await assertEstimateReady(id, 'send')
        await setStatus(await estimateId(), id, body.status as EstimateStatus, actor); break
      case 'set_approval':    await setApproval(await estimateId(), id, String(body.serviceId), body.state as ApprovalState, actor); break
      case 'convert': {
        const r = await convertEstimate(await estimateId(), id, actor)
        return NextResponse.json({ ok: true, synced: r.synced, ...(await getFullEstimate(id)) })
      }
      default:
        return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, view: await getEstimateView(id), ...(await getFullEstimate(id)) })
    }
    const order = await getOrderWithContext(id)
    if (!order) return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 })
    // Read-only lookups never take the edit lock (an AI call must not block a save/send).
    if (action === 'interpret' || action === 'catalog_list') return await perform()
    // A cancelled estimate/Job is kept for history only — no edits (reads above are still allowed).
    if (order.status === 'cancelled') return NextResponse.json({ ok: false, error: 'This estimate was cancelled. It is kept for history and can’t be changed.' }, { status: 409 })
    if (order.status === 'estimate') {
      // Standalone quotes use the dedicated conversion and email routes. All edits share
      // the same lock as send/conversion so a customer cannot receive a half-edited quote.
      const allowed = ['build', 'prepare', 'set_service_price', 'set_work_total', 'itemize', 'accept_total', 'add_service', 'rename_service', 'remove_service',
        'interpret', 'catalog_list', 'select_match', 'set_detail', 'add_part', 'update_part', 'remove_part', 'part_labor', 'add_tires',
        'convert_to_part', 'clarify_part']
      if (!allowed.includes(action)) return NextResponse.json({ error: 'Use the estimate actions to send or move this estimate.' }, { status: 400 })
      return await withIntakeLock(id, async () => {
        if ((await getOrderWithContext(id))?.status !== 'estimate') throw new Error('This estimate has moved to the Work Board. Refresh before editing.')
        if (body.serviceId) {
          const full = await getFullEstimate(id)
          if (!full?.services.some(s => s.id === body.serviceId && s.source !== 'system')) throw new Error('Service does not belong to this estimate.')
        }
        return perform()
      })
    }
    return await perform()
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

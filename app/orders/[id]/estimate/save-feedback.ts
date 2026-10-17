/**
 * Estimate page save feedback — the single "did this edit really save?" decision.
 *
 * Success is reported ONLY when the server answered ok AND its returned view actually reflects the
 * edit (a removed service is gone, a rename/price shows the new value). Anything else — HTTP error,
 * non-JSON reply, missing view, a view that disagrees, or no connection — is a failure with a plain
 * message, so the page never shows "Saved" for a change that isn't stored. Pure + fetch-injected so
 * it is unit-tested without a browser.
 */
export interface ServiceView {
  id: string; title: string; priceCents: number | null; suggestedCents: number | null
  catalogId?: string | null; catalogName?: string | null; description?: string; detail?: string | null; matchMethod?: string | null
  matchState?: 'matched' | 'custom' | 'unmatched' | 'choose'; qbMapped?: boolean; role?: string | null; entryText?: string | null
  /** Why the service must be chosen (matchState 'choose'). */
  chooseReason?: 'odor' | 'package' | 'ceramic' | 'name' | null
  partLike?: 'part' | 'ambiguous' | null
}
export type LaborStatus = 'needs_review' | 'labor_added' | 'included' | 'part_only' | 'waived'
export interface PartView {
  id: string; serviceId: string | null; description: string; fitment: string | null; partNumber: string | null; supplier: string | null
  quantity: number; unitCostCents: number | null; sellPriceCents: number | null; lineCents: number | null
  supply: 'shop' | 'customer'; laborStatus: LaborStatus; laborServiceId: string | null; laborNote: string | null; invoiceText: string
}
export interface ReviewIssue { code: 'part_labor' | 'odor_choice' | 'ceramic_choice' | 'name_choice' | 'service_as_part'; message: string; ids: string[] }
export interface EstimateViewData {
  exists: boolean; flat: boolean; workTotalCents: number; services: ServiceView[]; incomplete: boolean; referenceCents: number | null
  parts?: PartView[]; review?: { ready: boolean; issues: ReviewIssue[] }
}
export type EstimateEdit = Record<string, unknown> & { action: string }
export type SaveOutcome = { ok: true; view: EstimateViewData } | { ok: false; error: string }

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
const quote = (s: string) => `“${s}”`

/** Human labels for the status line: what is saving, what was saved, what failed. */
export function describeEdit(edit: EstimateEdit, view: EstimateViewData): { saving: string; saved: string; failed: string } {
  const svc = view.services.find((s) => s.id === edit.serviceId)
  const name = svc ? quote(svc.title) : 'the service'
  switch (edit.action) {
    case 'remove_service': return { saving: `Removing ${name}…`, saved: `${name} removed · Saved`, failed: `Couldn’t remove ${name} — it’s still on the estimate.` }
    case 'rename_service': return { saving: 'Saving name…', saved: `Renamed to ${quote(clean(edit.title))} · Saved`, failed: `Couldn’t rename ${name} — the old name is still saved.` }
    case 'set_service_price': return { saving: 'Saving price…', saved: `Price for ${name} saved`, failed: `Couldn’t save the price for ${name} — the previous price is still saved.` }
    case 'add_service': return { saving: 'Adding service…', saved: `${quote(clean(edit.title))} added · Saved`, failed: `Couldn’t add ${quote(clean(edit.title))}.` }
    case 'set_work_total': return { saving: 'Saving Work Total…', saved: 'Work Total saved', failed: 'Couldn’t save the Work Total — the previous amount is still saved.' }
    case 'select_match': return { saving: 'Saving service…', saved: `${name} updated · Saved`, failed: `Couldn’t change ${name} — the previous service is still saved.` }
    case 'set_detail': return { saving: 'Saving detail…', saved: 'Detail saved', failed: `Couldn’t save the detail for ${name}.` }
    case 'add_part': case 'add_tires': return { saving: 'Adding part…', saved: 'Part added · Saved', failed: 'Couldn’t add the part — nothing was saved.' }
    case 'update_part': return { saving: 'Saving part…', saved: 'Part saved', failed: 'Couldn’t save the part — the previous details are still saved.' }
    case 'remove_part': {
      const withLabor = (edit.labor as { action?: string } | undefined)?.action === 'remove'
      return withLabor
        ? { saving: 'Removing part and its labor…', saved: 'Part and its installation labor removed · Saved', failed: 'Couldn’t finish removing the part and its labor — Retry finishes what’s left.' }
        : { saving: 'Removing part…', saved: 'Part removed · Saved', failed: 'Couldn’t remove the part — it’s still on the estimate.' }
    }
    case 'part_labor': return { saving: 'Saving labor review…', saved: 'Labor review saved', failed: 'Couldn’t save the labor review.' }
    case 'convert_to_part': return { saving: 'Converting to a part…', saved: `${name} is now a part · Saved`, failed: `Couldn’t convert ${name} — it’s still a service line, unchanged.` }
    case 'clarify_part': return { saving: 'Adding the part…', saved: 'Part added and linked · Saved', failed: `Couldn’t add the part for ${name} — nothing was changed.` }
    default: return { saving: 'Saving…', saved: 'Saved', failed: 'Couldn’t save your change.' }
  }
}

/** Does the server's returned view actually reflect the edit? (null = yes; string = why not) */
function confirmsEdit(edit: EstimateEdit, view: EstimateViewData): string | null {
  const svc = view.services.find((s) => s.id === edit.serviceId)
  switch (edit.action) {
    case 'remove_service':
      return svc ? 'The server still lists this service.' : null
    case 'rename_service':
      return svc && clean(svc.title) === clean(edit.title) ? null : 'The server did not confirm the new name.'
    case 'set_service_price':
      // A flat-priced estimate itemizes on the first price edit, so the line must now show that price.
      return svc && svc.priceCents === edit.cents ? null : 'The server did not confirm the new price.'
    case 'add_service':
      return view.services.some((s) => clean(s.title).toLowerCase() === clean(edit.title).toLowerCase()) ? null : 'The server did not confirm the new service.'
    case 'select_match':
      if (!svc) return 'The server did not confirm the change.'
      return (edit.custom === true ? svc.matchState === 'custom' : svc.catalogId === edit.catalogId) ? null : 'The server did not confirm the selected service.'
    case 'set_detail':
      return svc && clean(svc.detail) === clean(edit.detail) ? null : 'The server did not confirm the detail.'
    case 'convert_to_part':
      // The service row is gone from Services and a part now bills on that same row.
      return !svc && (view.parts ?? []).some((p) => p.serviceId === edit.serviceId) ? null : 'The server did not confirm the conversion.'
    case 'clarify_part': {
      const want = clean((edit.part as { description?: unknown } | undefined)?.description).toLowerCase()
      return svc && (view.parts ?? []).some((p) => p.laborServiceId === edit.serviceId && clean(p.description).toLowerCase() === want) ? null : 'The server did not confirm the part.'
    }
    case 'remove_part': {
      if ((view.parts ?? []).some((p) => p.id === edit.partId)) return 'The server still lists this part.'
      const lab = edit.labor as { action?: string; serviceId?: string } | undefined
      if (lab?.action === 'remove' && view.services.some((s) => s.id === lab.serviceId)) return 'The server still lists the installation labor.'
      return null
    }
    case 'update_part': {
      const p = (view.parts ?? []).find((x) => x.id === edit.partId)
      const want = (edit.patch ?? {}) as { description?: unknown; sellPriceCents?: unknown }
      if (!p) return 'The server did not confirm the part.'
      if (want.description !== undefined && clean(p.description) !== clean(want.description)) return 'The server did not confirm the part name.'
      if (want.sellPriceCents !== undefined && p.supply === 'shop' && p.sellPriceCents !== want.sellPriceCents) return 'The server did not confirm the part price.'
      return null
    }
    case 'part_labor': {
      const p = (view.parts ?? []).find((x) => x.id === edit.partId)
      const want = ({ add_labor: 'labor_added', included: 'included', part_only: 'part_only', waive: 'waived', reopen: 'needs_review' } as Record<string, string>)[String((edit.labor as { action?: string } | undefined)?.action)]
      return p && p.laborStatus === want ? null : 'The server did not confirm the labor review.'
    }
    default:
      return null
  }
}

/** Interpret one estimate-edit response. */
export function interpretSave(edit: EstimateEdit, res: { ok: boolean; status: number }, body: unknown): SaveOutcome {
  const d = (body && typeof body === 'object' ? body : {}) as { ok?: unknown; error?: unknown; view?: EstimateViewData }
  if (!res.ok || d.ok !== true) {
    const msg = typeof d.error === 'string' && d.error.trim() ? d.error.trim() : `The server returned an error (${res.status}).`
    return { ok: false, error: msg }
  }
  if (!d.view || !Array.isArray(d.view.services)) return { ok: false, error: 'The server didn’t confirm the change.' }
  const mismatch = confirmsEdit(edit, d.view)
  return mismatch ? { ok: false, error: mismatch } : { ok: true, view: d.view }
}

/** POST one edit to the estimate route and interpret it. Never throws. */
export async function saveEstimateEdit(orderId: string, edit: EstimateEdit, fetchImpl: typeof fetch = fetch): Promise<SaveOutcome> {
  let res: Response
  try {
    res = await fetchImpl(`/api/workflow/orders/${orderId}/estimate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit),
      // keepalive lets a price save initiated on blur finish even if the page is then unloaded
      // (tab close / hard refresh / mobile backgrounding). A backstop only — the status line + Retry
      // are the authoritative "did it save?" signal.
      keepalive: true,
    })
  } catch {
    return { ok: false, error: 'No connection — check the internet and try again.' }
  }
  const body = await res.json().catch(() => null)
  return interpretSave(edit, res, body)
}

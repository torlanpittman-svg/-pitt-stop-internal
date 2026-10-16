/**
 * Estimate page save feedback — the single "did this edit really save?" decision.
 *
 * Success is reported ONLY when the server answered ok AND its returned view actually reflects the
 * edit (a removed service is gone, a rename/price shows the new value). Anything else — HTTP error,
 * non-JSON reply, missing view, a view that disagrees, or no connection — is a failure with a plain
 * message, so the page never shows "Saved" for a change that isn't stored. Pure + fetch-injected so
 * it is unit-tested without a browser.
 */
export interface ServiceView { id: string; title: string; priceCents: number | null; suggestedCents: number | null }
export interface EstimateViewData { exists: boolean; flat: boolean; workTotalCents: number; services: ServiceView[]; incomplete: boolean; referenceCents: number | null }
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

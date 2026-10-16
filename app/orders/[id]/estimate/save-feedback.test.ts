/**
 * The Estimate page shows "Saved" only when the server confirmed the edit, and a clear failure
 * (with Retry in the UI) otherwise. No network: fetch is injected.
 */
import { describe, it, expect } from 'vitest'
import { saveEstimateEdit, interpretSave, describeEdit, type EstimateViewData } from './save-feedback'

const view = (services: Array<[string, string, number | null]>): EstimateViewData => ({
  exists: true, flat: false, incomplete: false, referenceCents: null,
  workTotalCents: services.reduce((n, [, , c]) => n + (c ?? 0), 0),
  services: services.map(([id, title, priceCents]) => ({ id, title, priceCents, suggestedCents: null })),
})
const before = view([['s1', 'Two mirrors  and painted', 20000], ['s2', 'Interior detail', 17500]])
const afterRemove = view([['s2', 'Interior detail', 17500]])
const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch

describe('saveEstimateEdit — success only after the server confirms', () => {
  it('remove: confirmed when the returned view no longer has the service', async () => {
    const out = await saveEstimateEdit('o1', { action: 'remove_service', serviceId: 's1' }, fakeFetch(200, { ok: true, view: afterRemove }))
    expect(out).toEqual({ ok: true, view: afterRemove })
  })

  it('remove: NOT saved if the server answers ok but still lists the service', async () => {
    const out = await saveEstimateEdit('o1', { action: 'remove_service', serviceId: 's1' }, fakeFetch(200, { ok: true, view: before }))
    expect(out).toEqual({ ok: false, error: 'The server still lists this service.' })
  })

  it('server error message is passed through (e.g. stale page)', async () => {
    const out = await saveEstimateEdit('o1', { action: 'remove_service', serviceId: 's1' },
      fakeFetch(500, { ok: false, error: 'That service is no longer on this estimate. Refresh to see the current list.' }))
    expect(out).toEqual({ ok: false, error: 'That service is no longer on this estimate. Refresh to see the current list.' })
  })

  it('non-JSON / gateway error is a failure with the status, never "Saved"', async () => {
    const out = await saveEstimateEdit('o1', { action: 'set_service_price', serviceId: 's2', cents: 18000 }, fakeFetch(504, '<html>timeout</html>'))
    expect(out).toEqual({ ok: false, error: 'The server returned an error (504).' })
  })

  it('no connection is a failure with a plain message', async () => {
    const offline = (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch
    const out = await saveEstimateEdit('o1', { action: 'remove_service', serviceId: 's1' }, offline)
    expect(out).toEqual({ ok: false, error: 'No connection — check the internet and try again.' })
  })

  it('ok without a view is not treated as saved', () => {
    expect(interpretSave({ action: 'remove_service', serviceId: 's1' }, { ok: true, status: 200 }, { ok: true })).toEqual({ ok: false, error: 'The server didn’t confirm the change.' })
  })

  it('rename / price / add are confirmed against the returned view', () => {
    const renamed = view([['s1', 'Paint two mirror covers', 20000], ['s2', 'Interior detail', 17500]])
    expect(interpretSave({ action: 'rename_service', serviceId: 's1', title: ' Paint two  mirror covers ' }, { ok: true, status: 200 }, { ok: true, view: renamed }).ok).toBe(true)
    expect(interpretSave({ action: 'rename_service', serviceId: 's1', title: 'Something else' }, { ok: true, status: 200 }, { ok: true, view: renamed }).ok).toBe(false)
    expect(interpretSave({ action: 'set_service_price', serviceId: 's2', cents: 17500 }, { ok: true, status: 200 }, { ok: true, view: before }).ok).toBe(true)
    expect(interpretSave({ action: 'set_service_price', serviceId: 's2', cents: 19900 }, { ok: true, status: 200 }, { ok: true, view: before }).ok).toBe(false)
    expect(interpretSave({ action: 'add_service', title: 'interior DETAIL' }, { ok: true, status: 200 }, { ok: true, view: before }).ok).toBe(true)
    expect(interpretSave({ action: 'add_service', title: 'Wax' }, { ok: true, status: 200 }, { ok: true, view: before }).ok).toBe(false)
  })
})

describe('describeEdit — the status line names what is saving / saved / failed', () => {
  it('remove', () => {
    expect(describeEdit({ action: 'remove_service', serviceId: 's1' }, before)).toEqual({
      saving: 'Removing “Two mirrors  and painted”…',
      saved: '“Two mirrors  and painted” removed · Saved',
      failed: 'Couldn’t remove “Two mirrors  and painted” — it’s still on the estimate.',
    })
  })
  it('price failure says the previous price is still saved', () => {
    expect(describeEdit({ action: 'set_service_price', serviceId: 's2', cents: 1 }, before).failed).toBe('Couldn’t save the price for “Interior detail” — the previous price is still saved.')
  })
})

describe('part-review edits — Saved only when the returned view shows the change', () => {
  const withPart = (serviceId: string, laborServiceId: string | null = null, description = 'Mirror'): EstimateViewData => ({
    ...view([['s2', 'Interior detail', 17500]]),
    parts: [{ id: 'p1', serviceId, description, fitment: null, partNumber: null, supplier: null, quantity: 1, unitCostCents: null, sellPriceCents: 26500, lineCents: 26500,
      supply: 'shop', laborStatus: 'needs_review', laborServiceId, laborNote: null, invoiceText: description }],
  })
  it('convert_to_part: confirmed when the service row is gone from Services and a part bills on that row', () => {
    expect(interpretSave({ action: 'convert_to_part', serviceId: 's1' }, { ok: true, status: 200 }, { ok: true, view: withPart('s1') }).ok).toBe(true)
    expect(interpretSave({ action: 'convert_to_part', serviceId: 's1' }, { ok: true, status: 200 }, { ok: true, view: before }).ok).toBe(false)
  })
  it('clarify_part: confirmed only when the named part is linked to this line', () => {
    const v = { ...withPart('other', 's2', 'Windshield') }
    expect(interpretSave({ action: 'clarify_part', serviceId: 's2', part: { description: 'Windshield' } }, { ok: true, status: 200 }, { ok: true, view: v }).ok).toBe(true)
    expect(interpretSave({ action: 'clarify_part', serviceId: 's2', part: { description: 'Windshield' } }, { ok: true, status: 200 }, { ok: true, view: before }).ok).toBe(false)
  })
  it('a failed conversion keeps a plain message saying nothing changed', async () => {
    const out = await saveEstimateEdit('o1', { action: 'convert_to_part', serviceId: 's1' }, fakeFetch(500, { ok: false, error: 'describes work, not a part' }))
    expect(out).toEqual({ ok: false, error: 'describes work, not a part' })
    expect(describeEdit({ action: 'convert_to_part', serviceId: 's1' }, before).failed).toMatch(/still a service line, unchanged/)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB so the route's SQL is never executed for real; `execute` returns fixture rows in the
// same shape the two SELECTs alias to. No Neon, no writes — a pure regression over the result budget.
const execute = vi.fn()
vi.mock('@/platform/db', () => ({ getDb: () => ({ execute }) }))

import { GET } from './route'

type Row = {
  customerName: string; customerPhone: string | null; customerEmail: string | null
  vehicleId: string | null; year: string | null; make: string | null; model: string | null; vin: string | null
}
const person = (name: string, phone: string): Row =>
  ({ customerName: name, customerPhone: phone, customerEmail: null, vehicleId: null, year: null, make: null, model: null, vin: null })

const req = (q: string) => new Request(`http://localhost/api/quick-entry/customers?q=${encodeURIComponent(q)}`)

beforeEach(() => execute.mockReset())

describe('GET /api/quick-entry/customers result budget', () => {
  it('returns a customer past the old 8-result cutoff (regression: the 13th match was dropped)', async () => {
    // 13 distinct directory people (by phone), ordered, with a synthetic customer — Mara Example —
    // sitting 13th alphabetically, i.e. beyond the previous hard cap of 8 where she was being cut off.
    const dir = Array.from({ length: 13 }, (_, i) => person(`Person ${String(i).padStart(2, '0')}`, `555000${String(i).padStart(4, '0')}`))
    dir[12] = person('Mara Example', '5550009999')
    execute.mockResolvedValueOnce({ rows: dir }).mockResolvedValueOnce({ rows: [] }) // directory, then QE fallback

    const body = await (await GET(req('mar'))).json()
    expect(body.ok).toBe(true)
    expect(body.customers).toHaveLength(13)
    expect(body.capped).toBe(false)
    const idx = body.customers.findIndex((c: { name: string }) => c.name === 'Mara Example')
    expect(idx).toBe(12)              // present…
    expect(idx).toBeGreaterThan(7)    // …and specifically beyond the old 8-result head
  })

  it('caps the list at 25 people and flags capped=true so the UI can prompt to refine', async () => {
    const dir = Array.from({ length: 30 }, (_, i) => person(`Person ${String(i).padStart(2, '0')}`, `555${String(i).padStart(7, '0')}`))
    execute.mockResolvedValueOnce({ rows: dir }).mockResolvedValueOnce({ rows: [] })

    const body = await (await GET(req('per'))).json()
    expect(body.customers).toHaveLength(25)
    expect(body.capped).toBe(true)
  })

  it('short-circuits a too-short query without touching the database', async () => {
    const body = await (await GET(req('a'))).json()
    expect(body).toEqual({ ok: true, customers: [] })
    expect(execute).not.toHaveBeenCalled()
  })
})

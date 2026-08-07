/**
 * Returning-customer search + aggregation (pure helpers). Retail customers are
 * derived from existing quick_entry_jobs history (name/phone/email + vehicle),
 * reusing real Pitt Stop records — no separate customers table, no AutoLeap.
 */
export function normalizePhone(p?: string | null): string { return (p ?? '').replace(/\D/g, '') }
export function normalizeName(n?: string | null): string { return (n ?? '').trim().replace(/\s+/g, ' ').toLowerCase() }

export function splitName(full?: string | null): { first: string; last: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean)
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') }
}

/** Identity key for de-duping people: phone first, then email, then normalized name. */
export function customerKey(c: { phone?: string | null; email?: string | null; name?: string | null }): string {
  const ph = normalizePhone(c.phone); if (ph) return 'p:' + ph
  const em = (c.email ?? '').trim().toLowerCase(); if (em) return 'e:' + em
  return 'n:' + normalizeName(c.name)
}

export function vehicleLabel(v: { year?: string | null; make?: string | null; model?: string | null }): string {
  return [v.year, v.make, v.model].filter(Boolean).join(' ')
}

export interface CustVehicle { id: string; year: string | null; make: string | null; model: string | null; vin: string | null; label: string }
export interface CustomerMatch { name: string; first: string; last: string; phone: string | null; email: string | null; vehicles: CustVehicle[] }

export interface JobRow {
  customerName: string | null; customerPhone: string | null; customerEmail: string | null
  vehicleId: string | null; year: string | null; make: string | null; model: string | null; vin: string | null
}

/**
 * Group rows (already ordered newest-first) into distinct returning customers with
 * their known vehicles. Latest contact info wins; vehicles de-duped by id; vehicles
 * with no label and no VIN are dropped. Returns up to `limit` customers.
 */
export function aggregateCustomers(rows: JobRow[], limit = 8): CustomerMatch[] {
  const map = new Map<string, CustomerMatch>()
  const vehSeen = new Map<string, Set<string>>()
  for (const r of rows) {
    const key = customerKey({ phone: r.customerPhone, email: r.customerEmail, name: r.customerName })
    let m = map.get(key)
    if (!m) {
      const { first, last } = splitName(r.customerName)
      m = { name: (r.customerName ?? '').trim(), first, last, phone: r.customerPhone ?? null, email: r.customerEmail ?? null, vehicles: [] }
      map.set(key, m); vehSeen.set(key, new Set())
    }
    if (r.vehicleId) {
      const seen = vehSeen.get(key)!
      const label = vehicleLabel(r)
      if (!seen.has(r.vehicleId) && (label || r.vin)) {
        seen.add(r.vehicleId)
        m.vehicles.push({ id: r.vehicleId, year: r.year, make: r.make, model: r.model, vin: r.vin, label: label || (r.vin ? `VIN …${r.vin.slice(-6)}` : 'Vehicle') })
      }
    }
  }
  return [...map.values()].slice(0, limit)
}

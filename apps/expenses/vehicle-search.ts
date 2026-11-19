/**
 * Auto Sales vehicle search for the Receipts picker — PURE (client-safe, unit-tested). The whole inventory is
 * small and already on the page, so the search runs in the browser: every word typed must appear in the
 * vehicle's stock number, VIN, year, make or model.
 */
export interface VehicleOption {
  id: string; label: string
  stock?: string | null; vin?: string | null; year?: string | null; make?: string | null; model?: string | null
  sold?: boolean
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function matchVehicles<V extends VehicleOption>(vehicles: readonly V[], q: string): V[] {
  const tokens = norm(q).split(' ').filter(Boolean)
  if (tokens.length === 0) return [...vehicles]
  return vehicles.filter((v) => {
    const hay = norm([v.stock, v.vin, v.year, v.make, v.model].filter(Boolean).join(' '))
    const compact = hay.replace(/ /g, '')   // so "ps4821" finds stock "PS-4821"
    return tokens.every((t) => hay.includes(t) || compact.includes(t))
  })
}

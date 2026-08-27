/**
 * Owned-inventory stock number: PS-{last 4 of VIN}. VIN is canonical; this is only the operational
 * human id. On collision with another owned vehicle, extend the VIN suffix (last 5, 6, …) until
 * unique. Never invents digits; if the VIN suffix can't be established, returns null (→ Needs Review).
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { inventoryVehicles } from './schema'

const clean = (vin: string) => vin.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '') // VINs exclude I,O,Q

/** Proposed stock for a VIN using the shortest unique suffix ≥4. `excludeId` skips the row being
 *  updated. Returns null when there aren't ≥4 usable VIN chars (identity unresolved → Needs Review). */
export async function generateStockNumber(vin: string | null | undefined, excludeId?: string): Promise<string | null> {
  const v = clean(vin ?? '')
  if (v.length < 4) return null
  const db = getDb()
  for (let n = 4; n <= v.length; n++) {
    const candidate = `PS-${v.slice(-n)}`
    const clash = await db.select({ id: inventoryVehicles.id }).from(inventoryVehicles)
      .where(excludeId
        ? and(eq(inventoryVehicles.stockNumber, candidate), ne(inventoryVehicles.id, excludeId))
        : eq(inventoryVehicles.stockNumber, candidate))
      .limit(1)
    if (clash.length === 0) return candidate
  }
  // Every suffix up to the full VIN collides (extraordinary — same VIN already owned). Disambiguate.
  const full = `PS-${v}`
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(inventoryVehicles)
    .where(sql`${inventoryVehicles.stockNumber} like ${full + '%'}`)
  return `${full}-${(c ?? 0) + 1}`
}

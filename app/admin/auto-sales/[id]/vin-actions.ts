'use server'
/** Server action for attaching a VIN to an inventory vehicle (admin page is proxy-gated). Re-decodes
 *  authoritatively + dedup + conflict detection in apps/auto-sales/db.resolveVin. No money movement. */
import { resolveVin, type VinResolveResult } from '@/apps/auto-sales/db'

export async function resolveVinAction(inventoryVehicleId: string, rawVin: string, confirmConflict: boolean): Promise<VinResolveResult> {
  return resolveVin({ inventoryVehicleId, rawVin, confirmConflict, actor: 'admin' })
}

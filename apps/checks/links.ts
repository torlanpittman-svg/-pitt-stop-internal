/**
 * Job / vehicle linkage for Write-a-Check. Two business-language categories carry a soft link to
 * operational records so the CFO can attribute the spend precisely:
 *   - Customer Job  → a current Work Board service order (operating entity)
 *   - Auto Sales    → an inventory vehicle (auto_sales entity — kept off operating CFO)
 *
 * These are READ-ONLY, compact lookups. The check row stores only the id (soft link, no FK); this
 * module resolves ids back to a human label for the confirmation screen and Check History. A link that
 * no longer resolves (record removed) degrades gracefully to the stored id — it never throws.
 */
import { listActiveOrders } from '@/apps/workflow/db'
import { getInventoryList } from '@/apps/auto-sales/db'

export interface LinkOption { id: string; label: string; sub?: string | null }

function vehicleDesc(v: { year?: string | null; make?: string | null; model?: string | null } | null | undefined): string {
  if (!v) return ''
  return [v.year, v.make, v.model].filter(Boolean).join(' ').trim()
}

/** Current Work Board jobs a Customer Job check can be attributed to (active, most-recent first). */
export async function listLinkableJobs(): Promise<LinkOption[]> {
  const orders = await listActiveOrders()
  return orders.map((o) => {
    const veh = vehicleDesc(o.vehicle)
    const plate = o.vehicle?.licensePlate || null
    const who = o.customerName || 'Unknown customer'
    return {
      id: o.id,
      label: `${who}${veh ? ` — ${veh}` : ''}`,
      sub: [`#${o.orderNumber}`, plate, o.status].filter(Boolean).join(' · '),
    }
  })
}

/** Auto Sales inventory vehicles an Auto Sales check can be attributed to. */
export async function listLinkableVehicles(): Promise<LinkOption[]> {
  const rows = await getInventoryList()
  return rows.map((r) => ({
    id: r.id,
    label: [r.stockNumber, vehicleDesc(r)].filter(Boolean).join(' · ') || r.id,
    sub: [r.status, r.vin].filter(Boolean).join(' · ') || null,
  }))
}

/** Resolve a stored linked job/vehicle id to a display label for confirmation + history. Never throws. */
export async function resolveLinkLabel(opts: { linkedJobId?: string | null; linkedVehicleId?: string | null }): Promise<string | null> {
  try {
    if (opts.linkedJobId) {
      const jobs = await listLinkableJobs()
      const hit = jobs.find((j) => j.id === opts.linkedJobId)
      return hit ? hit.label : `Job ${opts.linkedJobId.slice(0, 8)}`
    }
    if (opts.linkedVehicleId) {
      const veh = await listLinkableVehicles()
      const hit = veh.find((v) => v.id === opts.linkedVehicleId)
      return hit ? hit.label : `Vehicle ${opts.linkedVehicleId.slice(0, 8)}`
    }
  } catch { /* linkage is best-effort — never block a check */ }
  return null
}

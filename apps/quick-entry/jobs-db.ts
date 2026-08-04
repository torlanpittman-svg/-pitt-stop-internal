/**
 * Quick Entry jobs — catalog read for the buttons + job capture onto the Work Board.
 * No QuickBooks or AutoLeap. A captured job creates a workflow service_order so it
 * appears on /work-board, plus a quick_entry_jobs record (customer + lines).
 */
import { getDb } from '@/platform/db'
import { quickEntryJobs, quickEntryJobLines } from './schema'
import { getFullCatalog, listTechnicianInstructions, type FullCatalogItem, type TechRow } from './db'
import { serviceLabels } from './job-lines'
import { findOrCreateVehicle, createServiceOrder } from '@/apps/workflow/db'

export interface QuickEntryCatalog { packages: FullCatalogItem[]; addons: FullCatalogItem[]; tech: TechRow[] }

/** Retail Quick-Entry catalog for the buttons (dealer packages are excluded — dealer work
 *  goes through Dealer Check-In). Active + quick-entry only, with price tiers. */
export async function getQuickEntryCatalog(): Promise<QuickEntryCatalog> {
  const [full, tech] = await Promise.all([getFullCatalog(), listTechnicianInstructions()])
  const live = (f: FullCatalogItem) => f.item.active && f.item.quickEntry
  return {
    packages: full.filter((f) => f.item.kind === 'package' && f.item.source !== 'dealer_rules' && live(f)),
    addons:   full.filter((f) => f.item.kind === 'addon' && live(f)),
    tech,
  }
}

export interface JobLineInput {
  catalogId?: string | null; kind: 'package' | 'addon' | 'custom'
  name: string; size?: string | null; condition?: string | null; priceCents: number
}
export interface VehicleIdAudit {
  idMethod?: string | null        // plate_lookup | vin_camera | vin_upload | vin_manual | vehicle_manual
  plate?: string | null
  plateState?: string | null
  rawOcrVin?: string | null       // OCR/candidate VIN (may be invalid)
  lookupProvider?: string | null
  lookupStatus?: string | null
  lookupRequestId?: string | null
  vehicleEdited?: boolean | null
}
export interface CreateJobInput {
  customerName: string; customerPhone?: string | null; customerEmail?: string | null
  vehicle: { vin?: string | null; year?: string | null; make?: string | null; model?: string | null; color?: string | null }
  lines: JobLineInput[]
  techInstructions?: string[]
  createdBy?: string | null
  audit?: VehicleIdAudit
}

/** Create the job: find/create the vehicle, put it on the Work Board, store the job + lines. */
export async function createQuickEntryJob(input: CreateJobInput): Promise<{ jobId: string; serviceOrderId: string; orderNumber: string }> {
  const v = input.vehicle
  const vehicle = await findOrCreateVehicle({ vin: v.vin ?? null, year: v.year ?? null, make: v.make ?? null, model: v.model ?? null, color: v.color ?? null })

  const vehicleLabel = [v.year, v.make, v.model].filter(Boolean).join(' ') || v.vin || 'vehicle'
  // Selected service labels (standard package names + custom "Other" text), for the
  // Work Board card. Non-empty names only; no price / catalog metadata.
  const labels = serviceLabels(input.lines)
  const services = labels.join(', ')
  const notes = `Quick Entry · ${input.customerName} · ${vehicleLabel}${services ? ` · ${services}` : ''}`.slice(0, 500)
  const order = await createServiceOrder({
    vehicleId: vehicle.id, source: 'quick_entry', serviceType: 'retail',
    checkedInBy: input.createdBy ?? 'quick_entry', notes, services: labels,
  })

  const db = getDb()
  const a = input.audit ?? {}
  const totalCents = input.lines.reduce((s, l) => s + (Number(l.priceCents) || 0), 0)
  const [job] = await db.insert(quickEntryJobs).values({
    serviceOrderId: order.id, vehicleId: vehicle.id,
    customerName: input.customerName, customerPhone: input.customerPhone ?? null, customerEmail: input.customerEmail ?? null,
    vin: v.vin ?? null, year: v.year ?? null, make: v.make ?? null, model: v.model ?? null, color: v.color ?? null,
    totalCents, techInstructions: (input.techInstructions ?? []) as never, createdBy: input.createdBy ?? null,
    // Vehicle-identification audit (how the vehicle was identified). No secrets.
    idMethod: a.idMethod ?? null, plate: a.plate ?? null, plateState: a.plateState ?? null,
    rawOcrVin: a.rawOcrVin ?? null, finalVin: v.vin ?? null,
    lookupProvider: a.lookupProvider ?? null, lookupStatus: a.lookupStatus ?? null, lookupRequestId: a.lookupRequestId ?? null,
    vehicleEdited: a.vehicleEdited ?? false,
  }).returning()

  if (input.lines.length > 0) {
    await db.insert(quickEntryJobLines).values(input.lines.map((l, i) => ({
      jobId: job.id, catalogId: l.catalogId ?? null, kind: l.kind, name: l.name,
      size: l.size ?? null, condition: l.condition ?? null, priceCents: Number(l.priceCents) || 0, sortOrder: i,
    })))
  }
  return { jobId: job.id, serviceOrderId: order.id, orderNumber: order.orderNumber }
}

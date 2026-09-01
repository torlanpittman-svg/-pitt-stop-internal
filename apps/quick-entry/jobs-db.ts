/**
 * Quick Entry jobs — catalog read for the buttons + job capture onto the Work Board.
 * No QuickBooks or AutoLeap. A captured job creates a workflow service_order so it
 * appears on /work-board, plus a quick_entry_jobs record (customer + lines).
 */
import { getDb } from '@/platform/db'
import { sql } from 'drizzle-orm'
import { quickEntryJobs } from './schema'
import { getFullCatalog, listTechnicianInstructions, type FullCatalogItem, type TechRow } from './db'
import { serviceLabels } from './job-lines'
import { findOrCreateVehicle, getVehicleById, createServiceOrder } from '@/apps/workflow/db'
import { getOrCreateEstimate, promoteTextServices, recomputeEstimate, setExplicitPrice, setAgreedPrice, setInternalNote } from '@/apps/workflow/estimate-db'
import { searchServiceHistory, type HistoryEntry, type ServiceMatch } from './service-history'

// ── Retail service-history knowledge base (grounded in real completed work) ──
// Cached in-process (tiny dataset); a short TTL keeps it fresh as new Jobs complete. RETAIL ONLY —
// dealer work is excluded so dealer pricing can never leak into a retail suggestion.
let historyCache: { at: number; rows: HistoryEntry[] } | null = null
const HISTORY_TTL_MS = 5 * 60_000
async function loadRetailServiceHistory(): Promise<HistoryEntry[]> {
  if (historyCache && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache.rows
  const db = getDb()
  // Priced lines: non-generated job_line_items on RETAIL (non-dealer) estimates → name + price.
  // Name-only history: service_orders.services text on retail Jobs (adds families with no price yet).
  const priced = await db.execute(sql`
    SELECT li.name AS name, li.price_cents AS price_cents
    FROM job_line_items li
    JOIN job_services js ON js.id = li.job_service_id
    JOIN job_estimates je ON je.id = js.job_estimate_id
    JOIN service_orders so ON so.id = je.service_order_id
    WHERE li.generated = false AND li.price_cents > 0
      AND lower(coalesce(so.source,'')) NOT IN ('dealer','dealer_checkin')
      AND lower(coalesce(so.service_type,'')) NOT LIKE 'dealer%'
  `)
  const named = await db.execute(sql`
    SELECT jsonb_array_elements_text(so.services) AS name
    FROM service_orders so
    WHERE so.services IS NOT NULL AND jsonb_typeof(so.services) = 'array'
      AND lower(coalesce(so.source,'')) NOT IN ('dealer','dealer_checkin')
      AND lower(coalesce(so.service_type,'')) NOT LIKE 'dealer%'
  `)
  const rows: HistoryEntry[] = []
  for (const r of priced.rows as { name: string; price_cents: number }[]) rows.push({ name: r.name, priceCents: r.price_cents })
  for (const r of named.rows as { name: string }[]) if (r.name) rows.push({ name: r.name, priceCents: null })
  historyCache = { at: Date.now(), rows }
  return rows
}

/** Search the retail service history for families similar to the employee's typed "Other" name. */
export async function searchRetailServices(query: string): Promise<ServiceMatch[]> {
  if (!query || query.trim().length < 2) return []
  return searchServiceHistory(query, await loadRetailServiceHistory())
}

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
  /** An existing vehicle chosen for a returning customer — reused directly (no duplicate). */
  vehicleId?: string | null
  lines: JobLineInput[]
  techInstructions?: string[]
  createdBy?: string | null
  audit?: VehicleIdAudit
  /** Manager/admin-entered authoritative pre-fee/pre-tax work price (cents). The route
   *  only sets this for a manager/admin actor; null/absent → itemized/$0 as today. */
  workPriceCents?: number | null
  /** Employee-confirmed EXPECTED Job value at intake (pre-fee/pre-tax, cents) — the sum of the
   *  per-service intake prices. Operational production value; NOT the authoritative invoice price. */
  agreedPriceCents?: number | null
  /** Per-service intake audit: employee text + matched historical family/suggestion + confirmed price. */
  agreedServices?: Array<{ originalText: string; matchedFamily?: string | null; matchedDisplay?: string | null; suggestedCents?: number | null; sampleSize?: number | null; confirmedCents: number }>
  /** Internal note/instruction captured from NL intake → job_estimates.internalNotes. */
  internalNote?: string | null
}

/** Create the job: find/create the vehicle, put it on the Work Board, store the job + lines. */
export async function createQuickEntryJob(input: CreateJobInput): Promise<{ jobId: string; serviceOrderId: string; orderNumber: string }> {
  const v = input.vehicle
  // Reuse the exact existing vehicle when one was selected; otherwise find-or-create
  // (which itself de-dupes by VIN). Prevents duplicate vehicle rows for returning customers.
  const vehicle = (input.vehicleId ? await getVehicleById(input.vehicleId) : null)
    ?? await findOrCreateVehicle({ vin: v.vin ?? null, year: v.year ?? null, make: v.make ?? null, model: v.model ?? null, color: v.color ?? null })

  const vehicleLabel = [v.year, v.make, v.model].filter(Boolean).join(' ') || v.vin || 'vehicle'
  // Selected service labels (standard package names + custom "Other" text), for the
  // Work Board card. Non-empty names only; no price / catalog metadata.
  const labels = serviceLabels(input.lines)
  const services = labels.join(', ')
  const notes = `Quick Entry · ${input.customerName} · ${vehicleLabel}${services ? ` · ${services}` : ''}`.slice(0, 500)
  const order = await createServiceOrder({
    vehicleId: vehicle.id, source: 'quick_entry', serviceType: 'retail',
    checkedInBy: input.createdBy ?? 'quick_entry', notes, services: labels,
    customerName: input.customerName,  // Work Board card title
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

  // Release 2: the legacy quick_entry_job_lines INSERT has been removed — the unified
  // structures below (job_estimates → job_services, and job_line_items when pricing is
  // added later) are now the authoritative source for a new retail Job's services.
  // The quick_entry_job_lines table + all historical rows are left intact and untouched.

  // Build the unified commercial structures so job_estimates/job_services are the
  // authoritative source — WITHOUT changing the Quick Entry front-end. `service_orders
  // .services` stays the employee-facing summary; this only mirrors it into job_services
  // (idempotent, deduped) and creates the draft estimate.
  // Best-effort: this must never fail the Job creation (the Quick Entry contract).
  try {
    const est = await getOrCreateEstimate(order.id, input.createdBy ?? null)
    await promoteTextServices(est.id, order.id)   // service_orders.services → job_services (deduped)
    if (input.workPriceCents && input.workPriceCents > 0) {
      // Manager priced this Job: the amount is the authoritative pre-fee/pre-tax work
      // subtotal (explicit_pretax). No per-service line prices are fabricated.
      await setExplicitPrice(est.id, input.workPriceCents, input.createdBy ?? null)
    }
    // Employee-confirmed EXPECTED value at intake (any actor). Operational production value only —
    // does NOT set the authoritative invoice price / price_mode / fees / tax / QuickBooks.
    if (input.agreedPriceCents && input.agreedPriceCents > 0) {
      await setAgreedPrice(est.id, input.agreedPriceCents, {
        services: input.agreedServices ?? [], enteredBy: input.createdBy ?? null, at: new Date().toISOString(),
      }, input.createdBy ?? null)
    }
    if (input.internalNote && input.internalNote.trim()) {
      await setInternalNote(est.id, input.internalNote.trim())
    }
    await recomputeEstimate(est.id)               // itemized $0, or explicit price + fees/tax
  } catch (err) {
    console.error('[quick-entry] unified estimate build failed (Job still created):', err)
  }

  return { jobId: job.id, serviceOrderId: order.id, orderNumber: order.orderNumber }
}

/**
 * Quick Entry jobs — catalog read for the buttons + job capture onto the Work Board.
 * No QuickBooks or AutoLeap. A captured job creates a workflow service_order so it
 * appears on /work-board, plus a quick_entry_jobs record (customer + lines).
 */
import { normalizeServiceKey } from './catalog-identity'
import { getDb } from '@/platform/db'
import { sql } from 'drizzle-orm'
import { quickEntryJobs } from './schema'
import { getFullCatalog, listTechnicianInstructions, type FullCatalogItem, type TechRow } from './db'
import { serviceLabels } from './job-lines'
import { findOrCreateVehicle, getVehicleById, createServiceOrder } from '@/apps/workflow/db'
import { findOrCreateIntakeCustomer } from '@/apps/directory/intake-customer'
import { getOrCreateEstimate, promoteTextServices, recomputeEstimate, setExplicitPrice, setAgreedPrice, setInternalNote, toMatchMethod, type PromoteHint } from '@/apps/workflow/estimate-db'
import { addEstimatePart, addTireWork, installationCatalog } from '@/apps/parts/estimate-parts'
import { cleanDetail } from '@/apps/quickbooks/retail-format'
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
  /** The employee's original typed wording (kept for traceability; never sent to QuickBooks). */
  entryText?: string | null
  /** Job-specific area/component ("passenger seat"), kept separate from the service identity. */
  detail?: string | null
  /** How the identity was chosen at intake (exact / alias / rule / suggestion / shortcut / custom). */
  matchMethod?: string | null
  /** Confirmed physical part: who supplies it. The line's name is the part description. */
  partSupply?: 'shop' | 'customer' | null
  /** "Replace tires" clarified: supplying, installing customer-supplied tires, or both, and how many. */
  tires?: { mode: 'supply' | 'install_customer' | 'both'; quantity: number } | null
}

const INTAKE_METHODS = new Set(['exact', 'alias', 'rule', 'suggestion', 'shortcut'])

/** Server-side clean-up of the optional intake fields (never trust the client's shapes). */
export function sanitizeJobLine(l: JobLineInput): JobLineInput {
  const entry = typeof l.entryText === 'string' ? l.entryText.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  const tq = Number(l.tires?.quantity)
  const tires = l.tires && ['supply', 'install_customer', 'both'].includes(l.tires.mode) && Number.isInteger(tq) && tq >= 1 && tq <= 12
    ? { mode: l.tires.mode, quantity: tq } : null
  return {
    ...l,
    name: String(l.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    entryText: entry || null,
    detail: cleanDetail(l.detail),
    // Only how a REAL catalog choice was made; a client can never mark a line a confirmed one-off
    // ('custom'), which would skip the manager's odor / part review on the estimate.
    matchMethod: l.catalogId && INTAKE_METHODS.has(String(l.matchMethod)) ? toMatchMethod(l.matchMethod, 'shortcut') : null,
    partSupply: l.partSupply === 'shop' || l.partSupply === 'customer' ? l.partSupply : null,
    tires,
  }
}

const tireNoun = (qty: number) => (qty === 1 ? 'Tire' : 'Tires')

/** Work Board label(s) for one intake line — exactly the estimate row titles it will produce. */
function labelsFor(l: JobLineInput, installName: string | null): string[] {
  if (l.tires && installName) {
    const noun = tireNoun(l.tires.quantity)
    if (l.tires.mode === 'supply') return [noun]
    if (l.tires.mode === 'both') return [noun, installName]
    return [`Customer-supplied ${noun.toLowerCase()}`, installName]
  }
  if (l.partSupply) return [l.name]
  return [l.detail && !l.name.toLowerCase().includes(l.detail.toLowerCase()) ? `${l.name} — ${l.detail}` : l.name]
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
  /** Operational urgency set at check-in (defaults Normal). Visual/sort only. */
  isUrgent?: boolean
}

/** Create the job: find/create the vehicle, put it on the Work Board, store the job + lines. */
export async function createQuickEntryJob(input: CreateJobInput): Promise<{ jobId: string; serviceOrderId: string; orderNumber: string }> {
  const v = input.vehicle
  // Reuse the exact existing vehicle when one was selected; otherwise find-or-create
  // (which itself de-dupes by VIN). Prevents duplicate vehicle rows for returning customers.
  const vehicle = (input.vehicleId ? await getVehicleById(input.vehicleId) : null)
    ?? await findOrCreateVehicle({ vin: v.vin ?? null, year: v.year ?? null, make: v.make ?? null, model: v.model ?? null, color: v.color ?? null })

  const vehicleLabel = [v.year, v.make, v.model].filter(Boolean).join(' ') || v.vin || 'vehicle'
  const lines = input.lines.map(sanitizeJobLine).filter((l) => l.name || l.tires)
  // Clarified tire work adds the catalog's installation service (no installation service → the line
  // is kept as plain typed text instead, so nothing is lost).
  const install = lines.some((l) => l.tires && l.tires.mode !== 'supply') ? await installationCatalog().catch(() => null) : null
  const installName = install?.name ?? null
  const usable = (l: JobLineInput) => !l.tires || l.tires.mode === 'supply' || !!installName
  // Selected service labels (standard package names + custom "Other" text + confirmed parts), for the
  // Work Board card — each is exactly the estimate row title it becomes, so nothing is re-created twice.
  const labels = [...new Set(serviceLabels(lines.flatMap((l) => (usable(l) ? labelsFor(l, installName) : [l.name])).map((name) => ({ name }))))]
  const services = labels.join(', ')
  const notes = `Quick Entry · ${input.customerName} · ${vehicleLabel}${services ? ` · ${services}` : ''}`.slice(0, 500)

  // Promote the customer into the canonical directory and link the vehicle, so they are searchable
  // on /customers and this Job attaches to their profile/history. Best-effort: a directory hiccup
  // must NEVER fail Job creation (the Quick Entry contract) — on failure customerId stays null, i.e.
  // the pre-fix behaviour. Reuses the QB resolver's unique-evidence match rule so no duplicate row.
  let customerId: string | null = null
  try {
    const link = await findOrCreateIntakeCustomer(
      { name: input.customerName, phone: input.customerPhone ?? null, email: input.customerEmail ?? null },
      vehicle.id,
    )
    customerId = link?.id ?? null
  } catch (err) {
    console.error('[quick-entry] directory customer link failed (Job still created):', err)
  }

  const order = await createServiceOrder({
    vehicleId: vehicle.id, source: 'quick_entry', serviceType: 'retail',
    checkedInBy: input.createdBy ?? 'quick_entry', notes, services: labels,
    customerName: input.customerName,  // Work Board card title
    customerId,                        // canonical directory link (null if resolution failed)
    isUrgent: input.isUrgent ?? false,
  })

  const db = getDb()
  const a = input.audit ?? {}
  const totalCents = lines.reduce((s, l) => s + (Number(l.priceCents) || 0), 0)
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
    const actor = input.createdBy ?? null
    // Confirmed parts and clarified tire work go through the ONE parts workflow first (special-order
    // part + installation-labor review; no price is invented — the manager prices them on the estimate).
    // Each is best-effort: on failure its label is promoted below as a plain service, so nothing is lost.
    for (const l of lines) {
      try {
        if (l.tires && usable(l)) await addTireWork(order.id, { mode: l.tires.mode, quantity: l.tires.quantity, entryText: l.entryText ?? l.name }, actor, null)
        else if (l.partSupply) await addEstimatePart(order.id, { description: l.name, supply: l.partSupply, entryText: l.entryText ?? null }, actor)
      } catch (err) {
        console.error('[quick-entry] part intake failed (kept as a service line):', err)
      }
    }
    // Tapped shortcuts / confirmed suggestions carry their catalog id → that exact identity is kept
    // (label text is display only), with the employee's original wording and the job-specific detail.
    const agreed = input.agreedServices ?? []
    const hints = new Map<string, PromoteHint>()
    for (const l of lines) {
      if (l.tires || l.partSupply) continue
      const label = labelsFor(l, installName)[0]
      const typed = l.entryText
        ?? agreed.find((a) => a.originalText && normalizeServiceKey(a.originalText) !== normalizeServiceKey(l.name)
          && [a.matchedDisplay, a.matchedFamily].some((m) => m && normalizeServiceKey(m) === normalizeServiceKey(l.name)))?.originalText
        ?? null
      hints.set(normalizeServiceKey(label), { catalogId: l.catalogId ?? null, entryText: typed, detail: l.detail ?? null, matchMethod: (l.matchMethod as PromoteHint['matchMethod']) ?? null })
    }
    await promoteTextServices(est.id, order.id, hints)   // service_orders.services → job_services (deduped)
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

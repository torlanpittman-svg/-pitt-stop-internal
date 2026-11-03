/**
 * Job-screen view of the estimate's items — PURE shaping over the authoritative estimate view
 * (apps/workflow/estimate-db getEstimateView). No pricing here: every amount is the line amount the
 * estimate/Invoice Draft already computed (customer price × quantity), so nothing can be charged twice.
 *
 *   • groupJobItems — parts attached to the service that installs them (job_parts.labor_service_id)
 *     sit under that service; every other live part is a standalone job part.
 *   • redactItemsView — what a non-manager may see: customer-facing amounts stay (they are on the
 *     customer's invoice anyway); OUR COST is internal and is stripped.
 */
import type { EstimateView, EstimatePartView, EstimateServiceView } from '@/apps/workflow/estimate-db'

/** Shown to a non-manager who taps Remove on a part that carries a live customer charge. */
/** Employee tried to remove a part from a Job that has a QuickBooks invoice (persisted linkage — not price/draft/send). */
export const INVOICED_NEEDS_MANAGER_MSG = 'This job has a QuickBooks invoice. Ask a manager to remove this part.'
/** Shown to a non-manager who taps Remove service. */
export const SERVICE_NEEDS_MANAGER_MSG = 'A manager is needed to remove a service from this job.'

export interface ServiceWithParts extends EstimateServiceView { parts: EstimatePartView[] }
export interface GroupedJobItems {
  services: ServiceWithParts[]
  /** Live parts not attached to any service (or attached to a service that is no longer on the estimate). */
  standalone: EstimatePartView[]
}

export function groupJobItems(view: Pick<EstimateView, 'services' | 'parts'>): GroupedJobItems {
  const byService = new Map<string, EstimatePartView[]>()
  const standalone: EstimatePartView[] = []
  const serviceIds = new Set(view.services.map((s) => s.id))
  for (const p of view.parts ?? []) {
    const covered = (p.laborStatus === 'included' || p.laborStatus === 'labor_added') && p.laborServiceId && serviceIds.has(p.laborServiceId)
    if (covered) (byService.get(p.laborServiceId!) ?? byService.set(p.laborServiceId!, []).get(p.laborServiceId!)!).push(p)
    else standalone.push(p)
  }
  return { services: view.services.map((s) => ({ ...s, parts: byService.get(s.id) ?? [] })), standalone }
}

/** Strip internal cost for non-managers. Customer price / line amounts are kept (they are the customer's charge). */
export function redactItemsView<T extends Pick<EstimateView, 'parts'>>(view: T, manager: boolean): T {
  if (manager) return view
  return { ...view, parts: (view.parts ?? []).map((p) => ({ ...p, unitCostCents: null })) }
}

/** Plain-language confirmation for removing a service, naming what goes with it. */
export function removeServiceMessage(title: string, attached: readonly { description: string }[]): string {
  if (attached.length === 0) return `Remove “${title}” from this job? Its price will be removed from the job total.`
  const names = attached.map((p) => `“${p.description}”`).join(', ')
  return attached.length === 1
    ? `Remove “${title}” and its attached part ${names}? Both prices will be removed from the job total.`
    : `Remove “${title}” and its ${attached.length} attached parts (${names})? All of their prices will be removed from the job total.`
}

// ── Add-part draft validation (shared by the Job-screen form; the server re-validates every add) ──

/** "59" / "59.50" → whole cents; blank → null; anything else → 'bad'. */
export const centsFrom = (s: string): number | null | 'bad' => {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return 'bad'
  return Math.round(n * 100)
}

export interface PartDraft { name: string; cost: string; price: string; partNumber: string; quantity: string }
/** A validated add: whole cents, quantity ≥ 1 (decimals allowed), cost only when a manager typed one. */
export interface PartInput { name: string; priceCents: number; costCents: number | null; partNumber: string | null; quantity: number }
export type DraftProblem = { field: 'price' | 'cost' | 'quantity'; message: string }

/** Validate the draft. The customer price must be typed explicitly — a blank is a problem, never $0. */
export function validatePartDraft(f: PartDraft, manager: boolean): { ok: true; input: PartInput } | { ok: false; problem: DraftProblem } {
  const cost = manager ? centsFrom(f.cost) : null
  if (cost === 'bad') return { ok: false, problem: { field: 'cost', message: 'Check our cost — use a number like 59 or 59.50.' } }
  const price = centsFrom(f.price)
  if (price === null) return { ok: false, problem: { field: 'price', message: 'Enter the customer price · each (use 0 for no charge).' } }
  if (price === 'bad') return { ok: false, problem: { field: 'price', message: 'Check the customer price — use a number like 59 or 59.50.' } }
  const quantity = Number(f.quantity.trim() || 'x')
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, problem: { field: 'quantity', message: 'Enter a quantity of 1 or more.' } }
  return { ok: true, input: { name: f.name.trim(), priceCents: price, costCents: cost, partNumber: f.partNumber.trim() || null, quantity } }
}

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
export const NEEDS_MANAGER_MSG = 'This part is on the customer’s invoice. Ask a manager to remove it.'
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

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
/** A non-manager tried to add a part to a Job priced as ONE flat Work Price (a priced line would itemize it). */
export const FLAT_NEEDS_MANAGER_MSG = 'This job has a flat Work Price. Ask a manager to add this part.'
/** A non-manager tried to remove a part that carries its own installation charge (a separate labor line). */
export const LABOR_NEEDS_MANAGER_MSG = 'This part has its own installation charge. Ask a manager to remove it.'
/** Appended to a manager's confirmation when the part has its own installation line — the Job screen never removes labor. */
export const LABOR_STAYS_NOTE = 'Its separate installation charge stays on the job — remove it from the Invoice Draft if it no longer applies.'

export interface ServiceWithParts extends EstimateServiceView { parts: EstimatePartView[] }
export interface GroupedJobItems {
  services: ServiceWithParts[]
  /** Live parts not attached to any service (or attached to a service that is no longer on the estimate / was declined). */
  standalone: EstimatePartView[]
}

export function groupJobItems(view: Pick<EstimateView, 'services' | 'parts'>): GroupedJobItems {
  const byService = new Map<string, EstimatePartView[]>()
  const standalone: EstimatePartView[] = []
  // A declined service isn't shown on the Job screen; a charged part attached to it is still billed, so it must
  // stay visible (and removable) — it is listed under Parts instead of vanishing with the service.
  const serviceIds = new Set(view.services.filter((s) => !s.declined).map((s) => s.id))
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

/**
 * The warning line for the Job screen's service removal (remove_service_with_parts: the attached
 * parts and their charges go with the line). Neutral on totals — a flat job's total stays fixed.
 * One wording for the swipe confirmation and the item editor's Remove.
 */
export function serviceRemovalConsequence(attached: readonly { description: string }[]): string {
  return attached.length === 0 ? 'Its charge will also be removed.'
    : attached.length === 1 ? `Its attached part “${attached[0].description}” and its charges will also be removed.`
    : `Its ${attached.length} attached parts (${attached.map((x) => `“${x.description}”`).join(', ')}) and their charges will also be removed.`
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

// ── "Assign to" for the add-part form (Whole job, or one of the Job's services) ──

/** The select value for a part that belongs to the whole Job (no service). */
export const WHOLE_JOB = 'job'

export interface PartAssignOption {
  /** Select value: WHOLE_JOB, `svc:<service id>`, or `text:<lower-cased title>` for a Work Board text-only service. */
  key: string
  label: string
}
export type PartAssignTarget =
  | { kind: 'job' }
  /** An estimate service — attached by ITS ID, so two services with the same name stay distinct. */
  | { kind: 'service'; serviceId: string; title: string }
  /** A service that only exists as Work Board text; the server mirrors it by title on add. */
  | { kind: 'text'; title: string }

const norm = (s: string) => s.trim().toLowerCase()
export const serviceAssignKey = (serviceId: string) => `svc:${serviceId}`
export const textAssignKey = (title: string) => `text:${norm(title)}`

/**
 * The "Assign to" choices, in screen order: Whole job, every listed (not declined) estimate service, then
 * each distinct text-only service. Services that share a name are told apart by position ("Oil Change
 * (1 of 2)") — the VALUE is always the service's own id, so the label never decides where a part goes.
 */
export function partAssignOptions(
  services: readonly { id: string; title: string; declined?: boolean }[],
  textOnlyTitles: readonly string[],
): PartAssignOption[] {
  const listed = services.filter((s) => !s.declined)
  const totals = new Map<string, number>()
  for (const s of listed) totals.set(norm(s.title), (totals.get(norm(s.title)) ?? 0) + 1)
  const seen = new Map<string, number>()
  const out: PartAssignOption[] = [{ key: WHOLE_JOB, label: 'Whole job' }]
  for (const s of listed) {
    const n = norm(s.title)
    const total = totals.get(n) ?? 1
    const nth = (seen.get(n) ?? 0) + 1
    seen.set(n, nth)
    out.push({ key: serviceAssignKey(s.id), label: total > 1 ? `${s.title} (${nth} of ${total})` : s.title })
  }
  const textSeen = new Set<string>()
  for (const t of textOnlyTitles) {
    const n = norm(t)
    if (!n || textSeen.has(n) || totals.has(n)) continue   // the server mirrors text services by title — one choice per title
    textSeen.add(n)
    out.push({ key: textAssignKey(t), label: t.trim() })
  }
  return out
}

/**
 * Where the chosen "Assign to" value sends the part. null = the choice is no longer on the Job (the service
 * was removed while the form was open) — the caller must ask again, never fall back to Whole job.
 */
export function resolvePartAssign(
  key: string,
  services: readonly { id: string; title: string; declined?: boolean }[],
  textOnlyTitles: readonly string[],
): PartAssignTarget | null {
  if (key === WHOLE_JOB) return { kind: 'job' }
  if (key.startsWith('svc:')) {
    const s = services.find((x) => !x.declined && serviceAssignKey(x.id) === key)
    return s ? { kind: 'service', serviceId: s.id, title: s.title } : null
  }
  if (key.startsWith('text:')) {
    const t = textOnlyTitles.find((x) => textAssignKey(x) === key)
    return t ? { kind: 'text', title: t.trim() } : null
  }
  return null
}

export const ASSIGN_GONE_MSG = 'That service is no longer on this job. Choose where the part goes and try again.'

// ── What a /parts response means for the form that sent it ──

export type PartsPostOutcome =
  /**
   * replayed = this request id had already saved the part (nothing new was written). differs = …and what was sent
   * now is not what was saved then (the form was edited before the retry) — the saved part was left as it was.
   * removed = …and the part has since been taken off the Job.
   */
  | { ok: true; partId: string | null; replayed: boolean; differs: boolean; removed: boolean }
  /**
   * saved: 'no' = the server answered that nothing was written (it refuses an add before, or by, its one atomic
   * write — never after), so the form can be corrected and sent again freely. 'unknown' = no answer, or one that
   * does not say: the part may have been saved. Sending the SAME form again settles it either way — the server
   * answers a repeat of a request id with the part saved the first time, never a second one.
   */
  | { ok: false; error: string; needsManager?: boolean; saved: 'no' | 'unknown' }

/** Classify a /parts response. `status` null = the request never produced a response. */
export function partsPostOutcome(status: number | null, body: { ok?: boolean; error?: string; needsManager?: boolean; partId?: string | null; replayed?: boolean; differs?: boolean; removed?: boolean } | null): PartsPostOutcome {
  if (status === null) return { ok: false, error: 'No connection — check the internet and try again.', saved: 'unknown' }
  if (status >= 200 && status < 300 && body?.ok) return { ok: true, partId: body.partId ?? null, replayed: body.replayed === true, differs: body.differs === true, removed: body.removed === true }
  const refused = status >= 400 && status < 500 && typeof body?.error === 'string' && body.error.length > 0
  if (refused) return { ok: false, error: body!.error!, needsManager: body?.needsManager, saved: 'no' }
  return { ok: false, error: 'Could not save — check your connection and try again.', saved: 'unknown' }
}

/** Shown in the add-part form while its last send is unconfirmed. The form stays editable. */
export const UNCONFIRMED_ADD_MSG = 'We couldn’t confirm whether this part was saved. Try again — it will not be added twice.'

/** What to tell the user when a retry found the part already saved by the first try. */
export function replayedAddMessage(name: string, place: { kind: 'job' } | { kind: 'service'; title: string } | null, differs: boolean): string {
  const where = !place ? 'on this job' : place.kind === 'job' ? 'on this job' : `under ${place.title}`
  return differs
    ? `“${name}” was already saved ${where} by your first try. The changes you made after that were not applied — tap the part to edit it.`
    : `${name} saved ${where}.`
}
export const removedAfterAddMessage = (name: string) => `“${name}” was saved by your first try and has since been removed from this job. Add it again if it is still needed.`

/**
 * After a RETRIED add reports success, where is that part really? The server answers a repeated request id with the
 * part from the first attempt — wherever that attempt left it, including cancelled (attach failed after the write).
 * So the page reads the Job back and reports what is true: the service it sits under, the whole job, or null when it
 * is not a live part of this Job at all (nothing was added — never announce it).
 */
export function placeOfAddedPart(view: Pick<EstimateView, 'services' | 'parts'>, partId: string | null): { kind: 'job' } | { kind: 'service'; serviceId: string; title: string } | null {
  if (!partId) return null
  const g = groupJobItems(view)
  if (g.standalone.some((p) => p.id === partId)) return { kind: 'job' }
  const s = g.services.find((x) => x.parts.some((p) => p.id === partId))
  return s ? { kind: 'service', serviceId: s.id, title: s.title } : null
}

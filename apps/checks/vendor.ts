/**
 * QuickBooks VENDOR (payee) resolution for check-writing — fail-closed, mirroring the retail-customer
 * resolver's safety model so a check is never booked against the wrong payee and duplicate vendors are
 * not created from capitalization/spacing differences.
 *
 * Resolution order for a typed payee name:
 *   1. QB exact DisplayName (case-insensitive, trimmed) → if EXACTLY ONE, use it
 *   2. more than one match → AMBIGUOUS → throw (never pick the first)
 *   3. zero matches → caller decides: create a new vendor ONLY on explicit confirmation
 *
 * decideVendor() is pure + unit-tested. searchVendors()/createVendor() wire it to QBO. Nothing here
 * mutates QuickBooks except createVendor(), which the service calls only after the manager confirms
 * "create new vendor".
 */
import { queryQBO, qbApiRequest, qboEscape } from '@/apps/quickbooks/client'
import { logger } from '@/platform/logger'

const APP = 'checks:vendor'

export interface QbVendor { id: string; displayName: string; active: boolean }

export class AmbiguousVendorError extends Error {
  constructor(public matches: QbVendor[]) {
    super(`Payee matches ${matches.length} QuickBooks vendors — resolve it in QuickBooks or pick one before writing the check.`)
    this.name = 'AmbiguousVendorError'
  }
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

const mapVendor = (v: { Id: string; DisplayName?: string; Active?: boolean }): QbVendor =>
  ({ id: v.Id, displayName: v.DisplayName ?? '', active: v.Active !== false })

/** ALL active QB vendors whose DisplayName exactly equals `name` (case-insensitive compared locally). */
export async function searchVendors(name: string): Promise<QbVendor[]> {
  const res = await queryQBO<{ Vendor?: Array<Parameters<typeof mapVendor>[0]> }>(
    `SELECT * FROM Vendor WHERE DisplayName = '${qboEscape(name.trim())}'`,
  )
  let list = (res.Vendor ?? []).map(mapVendor)
  // QBO's `=` is case-sensitive; also try a case-insensitive local match against a LIKE sweep so
  // "thompson derrig" resolves "Thompson Derrig" (still exact-after-normalize, never a fuzzy pick).
  if (list.length === 0) {
    const like = await queryQBO<{ Vendor?: Array<Parameters<typeof mapVendor>[0]> }>(
      `SELECT * FROM Vendor WHERE DisplayName LIKE '${qboEscape(name.trim())}%' MAXRESULTS 20`,
    )
    list = (like.Vendor ?? []).map(mapVendor).filter((v) => norm(v.displayName) === norm(name))
  }
  return list.filter((v) => v.active)
}

/** Fuzzy suggestions for the picker when there is no confident match (never auto-selected). */
export async function suggestVendors(term: string): Promise<QbVendor[]> {
  const t = term.trim()
  if (t.length < 2) return []
  const res = await queryQBO<{ Vendor?: Array<Parameters<typeof mapVendor>[0]> }>(
    `SELECT * FROM Vendor WHERE DisplayName LIKE '%${qboEscape(t)}%' MAXRESULTS 15`,
  )
  return (res.Vendor ?? []).map(mapVendor).filter((v) => v.active)
}

export async function createVendor(name: string): Promise<QbVendor> {
  const res = await qbApiRequest<{ Vendor: Parameters<typeof mapVendor>[0] }>({
    method: 'POST', path: '/vendor', body: { DisplayName: name.trim() },
  })
  logger.info(APP, 'vendor.created', { id: res.Vendor.Id, name: res.Vendor.DisplayName })
  return mapVendor(res.Vendor)
}

// ── Pure decision core (unit-tested) ─────────────────────────────────────────
export type VendorDecision =
  | { action: 'use'; vendorId: string; displayName: string }
  | { action: 'create' }
  | { action: 'ambiguous'; matches: QbVendor[] }

/** Deterministic selection: exactly one exact-normalized match → use; >1 → ambiguous; 0 → create. */
export function decideVendor(name: string, matches: QbVendor[]): VendorDecision {
  const exact = matches.filter((m) => norm(m.displayName) === norm(name))
  if (exact.length === 1) return { action: 'use', vendorId: exact[0].id, displayName: exact[0].displayName }
  if (exact.length > 1) return { action: 'ambiguous', matches: exact }
  return { action: 'create' }
}

export interface VendorPreview {
  decision: 'use' | 'create' | 'ambiguous'
  vendorId?: string
  displayName?: string
  matches: QbVendor[]        // exact matches (for ambiguity) — never auto-selected
  suggestions: QbVendor[]    // fuzzy suggestions for the picker
}

/** READ-ONLY: what WOULD happen for this payee, so the confirmation UI can show "existing vendor",
 *  "will create new vendor", or "pick which vendor" — without mutating QuickBooks. */
export async function previewVendor(name: string): Promise<VendorPreview> {
  const matches = await searchVendors(name)
  const decision = decideVendor(name, matches)
  const suggestions = decision.action === 'use' ? [] : await suggestVendors(name)
  if (decision.action === 'use') return { decision: 'use', vendorId: decision.vendorId, displayName: decision.displayName, matches, suggestions }
  if (decision.action === 'ambiguous') return { decision: 'ambiguous', matches: decision.matches, suggestions }
  return { decision: 'create', matches: [], suggestions }
}

export interface ResolveVendorOptions {
  /** When true, a zero-match name is created; when false it throws so the UI can confirm first. */
  allowCreate?: boolean
  /** Force a specific already-known vendor id (from the picker) — skips search entirely. */
  vendorId?: string | null
}

export class VendorNotFoundError extends Error {
  constructor(public name: string) { super(`No QuickBooks vendor named "${name}". Confirm creating a new vendor.`); this.name = 'VendorNotFoundError' }
}

/** Resolve the payee to a QBO Vendor.Id, failing closed on ambiguity. */
export async function resolveVendor(name: string, opts: ResolveVendorOptions = {}): Promise<QbVendor> {
  if (opts.vendorId) {
    // Trust an explicit pick from the confirmed suggestions, but verify it exists.
    const res = await queryQBO<{ Vendor?: Array<Parameters<typeof mapVendor>[0]> }>(`SELECT * FROM Vendor WHERE Id = '${qboEscape(opts.vendorId)}'`)
    const v = res.Vendor?.[0]
    if (v) return mapVendor(v)
    throw new VendorNotFoundError(name)
  }
  const matches = await searchVendors(name)
  const decision = decideVendor(name, matches)
  if (decision.action === 'use') return { id: decision.vendorId, displayName: decision.displayName, active: true }
  if (decision.action === 'ambiguous') throw new AmbiguousVendorError(decision.matches)
  if (!opts.allowCreate) throw new VendorNotFoundError(name)
  return createVendor(name)
}

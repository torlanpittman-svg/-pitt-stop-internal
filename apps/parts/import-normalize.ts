/**
 * PartsTech-screenshot import — PURE normalization + validation (no I/O, fully unit-testable).
 *
 * The AI reader's JSON is UNTRUSTED (so is the client). This module is the single boundary that turns a
 * raw proposal into validated, bounded data. Invariants enforced here:
 *   - Money is integer CENTS parsed with STRICT syntax; a missing/unreadable/ambiguous amount stays NULL —
 *     never coerced to $0, never invented, never salvaged from mixed text. A real printed $0.00 stays 0.
 *     Negatives, parentheses/credits, exponents, >2-decimal precision, and overflow are rejected to null.
 *   - The visible PURCHASE/unit cost is kept DISTINCT from list/MSRP and the line total. We NEVER derive one
 *     from another (no `total ÷ qty` arithmetic, no markup) — if only a line total is legible, unit cost is
 *     null. ONLY an explicitly cost-labeled field (unitCost/unit_cost/cost) becomes the purchase cost; a
 *     generic `price`/`retail`/`list`/`msrp` is treated as list metadata, NEVER as purchase cost.
 *   - Quantity is NOT guessed: a missing/invalid/non-positive/over-precise quantity stays NULL. A reviewer
 *     must confirm a positive quantity before apply — nothing is silently defaulted to 1 or clamped to 0.
 *   - Strings are trimmed and length-capped to the column widths.
 *   - The document kind (purchase|quote|cart|unknown) is an explicit allow-list — anything else is 'unknown'.
 *   - Extracted text is DATA ONLY: nothing here interprets instructions that may appear inside the image.
 *   - The row list is bounded, so a hallucinated/huge array can't create unbounded work.
 */
import { createHash } from 'node:crypto'

export const MAX_IMPORT_IMAGES = 4
export const MAX_IMPORT_ROWS = 60
// The MERGED cap across all pages of a batch. Up to 4 pages × MAX_IMPORT_ROWS could exceed this; the read
// truncates to this and flags `truncated`, and the review route accepts exactly this many rows — one number.
export const MAX_BATCH_ROWS = 120
export const DESCRIPTION_MAX = 300
export const PART_NUMBER_MAX = 80
export const BRAND_MAX = 80
export const SUPPLIER_MAX = 120
export const MAX_QUANTITY = 9999
export const MAX_MONEY_CENTS = 100_000_000 // $1,000,000 — a hard ceiling that blocks absurd/overflow amounts

export const DOCUMENT_KINDS = ['purchase', 'quote', 'cart', 'unknown'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]
export const LINK_DECISIONS = ['new', 'link', 'skip'] as const
export type LinkDecision = (typeof LINK_DECISIONS)[number]

export interface ImportRowProposal {
  description: string | null
  partNumber: string | null
  brand: string | null
  supplier: string | null
  quantity: number | null        // NULL when the screenshot's quantity is missing/unreadable — never guessed
  unitCostCents: number | null   // visible PURCHASE/unit cost only (explicitly cost-labeled)
  listPriceCents: number | null  // MSRP/list (metadata)
  lineTotalCents: number | null  // line total (metadata)
}
export interface ImportProposal {
  documentKind: DocumentKind
  supplier: string | null
  orderReference: string | null
  taxCents: number | null
  shippingCents: number | null
  coreCents: number | null
  rows: ImportRowProposal[]
  /** Count the model proposed BEFORE bounding — lets the UI say "showing 60 of N" honestly. */
  rawRowCount: number
}

export const EMPTY_PROPOSAL: ImportProposal = {
  documentKind: 'unknown', supplier: null, orderReference: null,
  taxCents: null, shippingCents: null, coreCents: null, rows: [], rawRowCount: 0,
}

// A strict dollar amount: optional "$", digits (optionally grouped in thousands), optional 1–2 decimals.
// No sign, no parentheses, no letters, no exponent, no 3+ decimal places. '$1,234.56', '0', '12.5', '0.00' pass.
const MONEY_GROUPED = /^\$?\d{1,3}(,\d{3})*(\.\d{1,2})?$/
const MONEY_PLAIN = /^\$?\d{1,12}(\.\d{1,2})?$/
// Quantity accepts a bare count with up to 2 decimals (1, 2, 0.5) — NOT currency-formatted, NOT signed.
const QTY_RE = /^\d{1,5}(\.\d{1,2})?$/

// A clean decimal spelling of a finite number (no exponent, no sign) — the SAME strict grammar is applied to
// a numeric input via its canonical string form, so epsilon/exponent/overflow (1e-9, 1e21) are rejected just
// like text junk. A real integer/decimal (0, 289, 12.5) spells cleanly and passes.
function decimalStringOf(v: number): string | null {
  if (!Number.isFinite(v) || v < 0) return null
  const s = String(v)
  return /^\d+(\.\d+)?$/.test(s) ? s : null
}

/**
 * Parse money to a NON-NEGATIVE integer-cents value, or null — STRICT syntax, no salvage.
 *   - number: accepted only through its clean decimal spelling (1e-9 → "1e-9" → rejected), ≤ 2 decimals,
 *     within the ceiling. A real 0 → 0.
 *   - string: must match a clean dollar amount (optional "$"/thousands commas, ≤ 2 decimals). A sign,
 *     parentheses, letters, exponent, or extra precision → null. No character stripping to "rescue" junk.
 * Booleans and other types → null. Never turns a missing/ambiguous amount into $0 or an invented value.
 */
export function parseCents(v: unknown): number | null {
  let s: string
  if (typeof v === 'number') { const d = decimalStringOf(v); if (d == null) return null; s = d }
  else if (typeof v === 'string') s = v.trim()
  else return null
  if (!s || (!MONEY_GROUPED.test(s) && !MONEY_PLAIN.test(s))) return null
  const n = Number(s.replace(/[$,]/g, ''))
  if (!Number.isFinite(n) || n < 0) return null
  const cents = Math.round(n * 100)
  if (cents < 0 || cents > MAX_MONEY_CENTS) return null
  return cents
}

/**
 * Normalize a quantity to a POSITIVE number with ≤ 2 decimals, or NULL. A missing/invalid/non-positive/
 * over-precise/epsilon quantity returns null — NEVER defaulted to 1 or clamped to 0 (1e-9 → null, '-2' →
 * null, 0 → null). The reviewer confirms a positive quantity before apply.
 */
export function normalizeQuantity(v: unknown): number | null {
  let s: string
  if (typeof v === 'number') { const d = decimalStringOf(v); if (d == null) return null; s = d }
  else if (typeof v === 'string') s = v.trim()
  else return null
  if (!QTY_RE.test(s)) return null
  const n = Number(s)
  const rounded = Math.round(n * 100) / 100
  if (!(rounded > 0) || rounded > MAX_QUANTITY) return null
  return rounded
}

export function normalizeDocumentKind(v: unknown): DocumentKind {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return (DOCUMENT_KINDS as readonly string[]).includes(s) ? (s as DocumentKind) : 'unknown'
}

export function normalizeLinkDecision(v: unknown): LinkDecision {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return (LINK_DECISIONS as readonly string[]).includes(s) ? (s as LinkDecision) : 'new'
}

function cleanStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

/** Normalize one raw row object → a bounded, validated proposal row.
 *  The purchase/unit cost comes ONLY from the model's explicit `unitCost`/`unit_cost` key (the prompt's
 *  schema names it). A generic `price`/`cost`/`retail`/`list` is NEVER treated as the purchase cost — an
 *  ambiguous amount can never silently become what the shop "paid". List/MSRP comes ONLY from an explicit
 *  `listPrice`/`list_price`/`msrp`. Ambiguous keys are intentionally left UNMAPPED (an honest unknown). */
export function normalizeRow(o: unknown): ImportRowProposal {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
  const unitCost = r.unitCost ?? r.unit_cost                 // explicit unit-cost ONLY
  const listPrice = r.listPrice ?? r.list_price ?? r.msrp    // explicit list/MSRP ONLY
  const lineTotal = r.lineTotal ?? r.line_total ?? r.extended ?? r.extendedPrice ?? r.extended_price
  return {
    description: cleanStr(r.description ?? r.name ?? r.item, DESCRIPTION_MAX),
    partNumber: cleanStr(r.partNumber ?? r.part_number ?? r.partNo ?? r.sku ?? r.number, PART_NUMBER_MAX),
    brand: cleanStr(r.brand ?? r.manufacturer ?? r.make, BRAND_MAX),
    supplier: cleanStr(r.supplier ?? r.store ?? r.vendor, SUPPLIER_MAX),
    quantity: normalizeQuantity(r.quantity ?? r.qty ?? r.count),
    unitCostCents: parseCents(unitCost),
    listPriceCents: parseCents(listPrice),
    lineTotalCents: parseCents(lineTotal),
  }
}

/** True when a row carries at least one piece of real content worth keeping (no all-null phantom rows). */
export function rowHasContent(r: ImportRowProposal): boolean {
  return !!(r.description || r.partNumber || r.unitCostCents != null || r.listPriceCents != null || r.lineTotalCents != null)
}

/**
 * Turn the parsed model JSON into a validated proposal. Drops empty/phantom rows, bounds the row count, and
 * never invents money. Exported for deterministic unit tests (missing fields → null, cost ≠ total, injected
 * instruction text is ignored as data, huge arrays are bounded).
 */
export function parsePartsImportJson(j: unknown): ImportProposal {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>
  const rawRows = Array.isArray(o.lineItems) ? o.lineItems
    : Array.isArray(o.items) ? o.items
    : Array.isArray(o.rows) ? o.rows
    : Array.isArray(o.parts) ? o.parts
    : []
  const rows = rawRows.map(normalizeRow).filter(rowHasContent).slice(0, MAX_IMPORT_ROWS)
  return {
    documentKind: normalizeDocumentKind(o.documentKind ?? o.document_kind ?? o.kind),
    supplier: cleanStr(o.supplier ?? o.store ?? o.vendor, SUPPLIER_MAX),
    orderReference: cleanStr(o.orderReference ?? o.order_reference ?? o.orderNumber ?? o.order_number ?? o.confirmation, 120),
    taxCents: parseCents(o.tax ?? o.taxTotal ?? o.tax_total),
    shippingCents: parseCents(o.shipping ?? o.freight ?? o.delivery),
    coreCents: parseCents(o.core ?? o.coreCharge ?? o.core_charge),
    rows,
    rawRowCount: rawRows.length,
  }
}

/** True when the model returned a usable result: at least one content-bearing line. A read that found no
 *  parts is a RECOVERABLE state (retry / enter manually), NOT a success with invented rows. */
export function proposalHasParts(p: ImportProposal): boolean {
  return p.rows.length > 0
}

/**
 * The reasons a row cannot be applied as a NEW tracked part yet (so the reviewer must fix them first). A
 * tracked part requires a non-empty description and a confirmed POSITIVE quantity — we never fabricate
 * either. 'link'/'skip' rows are not validated here (they don't create a new part). Pure + testable.
 */
export function newRowApplyIssues(row: { description: string | null; quantity: number | null }): string[] {
  const issues: string[] = []
  if (!row.description || !row.description.trim()) issues.push('description')
  if (row.quantity == null || !(row.quantity > 0)) issues.push('quantity')
  return issues
}

/**
 * Detect a MIXED-SUPPLIER document: more than one distinct supplier across the line rows (comparing each
 * row's supplier, falling back to the document supplier). One PartsTech import is ONE supplier order — a
 * mixed document must be corrected before a single supplier/order reference is stamped onto its parts or
 * the "already ordered" fast-path is offered. Case-insensitive; blank suppliers are ignored. Pure.
 */
export function supplierConflict(
  rows: ReadonlyArray<{ supplier: string | null }>,
  documentSupplier: string | null,
): { mixed: boolean; suppliers: string[] } {
  const seen = new Map<string, string>()
  const add = (raw: string | null | undefined) => {
    const t = (raw ?? '').trim()
    if (!t) return
    const key = t.toLowerCase()
    if (!seen.has(key)) seen.set(key, t)
  }
  // The document supplier counts too: a row that names a DIFFERENT store than the document is a conflict.
  add(documentSupplier)
  for (const r of rows) add(r.supplier)
  const suppliers = [...seen.values()]
  return { mixed: suppliers.length > 1, suppliers }
}

/**
 * Canonical content hash of a BATCH of screenshots: sha-256 over the member image hashes SORTED (order-
 * independent). Re-uploading the same set of screenshots to the same Job yields the same batch hash, so the
 * batch resumes instead of triggering a second AI read. Different screenshots → different hash.
 */
export function canonicalBatchHash(imageHashes: readonly string[]): string {
  const sorted = [...imageHashes].map((h) => h.trim().toLowerCase()).sort()
  return createHash('sha256').update(sorted.join('\n')).digest('hex')
}

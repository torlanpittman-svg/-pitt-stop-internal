/**
 * Dealer check-in business rules — pure functions, no I/O.
 *
 * Kept dependency-free so they are trivially unit-testable and can never be
 * broken silently by a refactor elsewhere. All QB/DB orchestration lives in
 * service.ts and calls into these.
 */

export const STANDARD_RATE = 200
export const NEW_STERLING_AUTO_RATE = 125

/** First letter of a stock number, uppercased. "K518991" → "K". */
export function extractStockPrefix(stockNumber: string | null | undefined): string | null {
  if (!stockNumber) return null
  return stockNumber.match(/^\s*([A-Za-z])/)?.[1]?.toUpperCase() ?? null
}

/**
 * QB line description in the confirmed Sterling format:
 * "YEAR MAKE MODEL COLOR #STOCK". Empty segments are dropped (no blank
 * placeholders), so a stockless tag yields e.g. "VW Atlas Blue".
 */
export function formatLineDescription(v: {
  year?: string | null
  make?: string | null
  model?: string | null
  color?: string | null
  stockNumber?: string | null
}): string {
  const vehicle = [v.year, v.make, v.model].filter(Boolean).join(' ')
  const color   = v.color?.trim() || ''
  const stock   = v.stockNumber?.trim() ? `#${v.stockNumber.trim()}` : ''
  return [vehicle || 'Unknown Vehicle', color, stock].filter(Boolean).join(' ')
}

export interface PricingSignals {
  stockNumber?: string | null
  tagColor?:    string | null // 'white' | 'yellow' | 'unknown'
}

export interface PricingDecision {
  standardRate:   number
  newVehicleRate: number
  /** default rate applied when no prompt is needed — always the standard rate */
  defaultRate:    number
  /** true when a new-Sterling-Auto signal fires and the user must be prompted */
  promptRequired: boolean
  signals:        string[]
}

/**
 * Decide pricing. Never auto-selects $125 — if a "new Sterling Auto vehicle"
 * signal is present (stock prefix T, or a white tag) the caller must prompt the
 * user to choose $125 vs $200. With no signal, $200 is used silently.
 */
export function decidePricing(s: PricingSignals): PricingDecision {
  const signals: string[] = []
  if (extractStockPrefix(s.stockNumber) === 'T') signals.push('stock prefix T')
  if ((s.tagColor ?? '').toLowerCase() === 'white') signals.push('white dealer tag')
  return {
    standardRate:   STANDARD_RATE,
    newVehicleRate: NEW_STERLING_AUTO_RATE,
    defaultRate:    STANDARD_RATE,
    promptRequired: signals.length > 0,
    signals,
  }
}

/** Validate an owner/user-chosen rate against the allowed values. */
export function isAllowedRate(rate: number): boolean {
  return rate === STANDARD_RATE || rate === NEW_STERLING_AUTO_RATE || (Number.isFinite(rate) && rate > 0)
}

export interface InvoiceLike {
  id:       string
  sent:     boolean
  balance:  number
  txnDate:  string | null
}

/**
 * Pick the invoice a new line should be appended to: the most recent OPEN
 * (balance > 0) and NOT-yet-sent invoice. Returns null when a fresh invoice must
 * be created (nothing open, or the only open invoices have been sent).
 */
export function selectAppendableInvoice<T extends InvoiceLike>(invoices: T[]): T | null {
  const appendable = invoices
    .filter((i) => i.balance > 0 && !i.sent)
    .sort((a, b) => (b.txnDate ?? '').localeCompare(a.txnDate ?? ''))
  return appendable[0] ?? null
}

/** Normalize a stock number for duplicate comparison (case/space-insensitive). */
export function normalizeStock(stock: string | null | undefined): string {
  return (stock ?? '').trim().toUpperCase()
}

/**
 * Resolve a dealership from a stock number by longest matching stock_prefix (case-
 * insensitive startsWith). This supports multi-character prefixes (e.g. "AP" →
 * Purdy Mazda) while being IDENTICAL to the old first-letter exact match for the
 * existing single-letter dealers (S/T/K/U): "S123" startsWith "S", and no existing
 * stock starts with "AP". Longest-match disambiguates any future overlap (e.g. an
 * "A" and an "AP" dealer). Returns null when nothing matches.
 */
export function matchDealershipByStock<T extends { stockPrefix: string | null }>(
  stockNumber: string | null | undefined,
  dealers: T[],
): T | null {
  const stock = normalizeStock(stockNumber)
  if (!stock) return null
  let best: T | null = null
  let bestLen = 0
  for (const d of dealers) {
    // A dealer with no prefix (NULL) is manual-pick only — it never auto-matches.
    const p = normalizeStock(d.stockPrefix)
    if (p && stock.startsWith(p) && p.length > bestLen) { best = d; bestLen = p.length }
  }
  return best
}

/**
 * The dealer for a check-in. An explicitly chosen dealer (the operator's dropdown
 * pick, or the dealer already confirmed on a scan) ALWAYS wins and is never replaced
 * by a stock-prefix guess — a BMW VIN suffix starting with "S" stays BMW. An unknown
 * id resolves to null (fail closed), never to the prefix match. Only when no dealer
 * was chosen does the stock prefix decide.
 */
export function pickDealer<T extends { id: string; stockPrefix: string | null }>(
  input: { dealershipId?: string | null; stockNumber?: string | null },
  dealers: T[],
): T | null {
  if (input.dealershipId) return dealers.find((d) => d.id === input.dealershipId) ?? null
  return matchDealershipByStock(input.stockNumber, dealers)
}

/**
 * Stock number of a dealer with NO prefix (e.g. BMW of College Station): the last 8
 * characters of the VIN, entered exactly as given. VIN alphabet (no I/O/Q).
 */
export const VIN_SUFFIX_STOCK_RE = /^[A-HJ-NPR-Z0-9]{8}$/i

/**
 * Normalize a manager-entered stock prefix. Blank → null ("no prefix", manual pick
 * only) — never '' (startsWith('') would match every stock). Returns undefined when
 * the value is not a valid prefix (1–10 letters/digits).
 */
export function normalizeDealerPrefix(raw: string | null | undefined): string | null | undefined {
  const p = (raw ?? '').trim().toUpperCase()
  if (!p) return null
  return /^[A-Z0-9]{1,10}$/.test(p) ? p : undefined
}

/**
 * Would giving a dealer this prefix change how ANOTHER dealer's stocks resolve?
 * With longest-prefix matching, a new prefix that extends an existing one (e.g. "S1"
 * when Sterling owns "S") would silently steal part of that dealer's stocks, and an
 * existing longer prefix inside a new shorter one makes the two compete. Both are
 * refused when the other dealer bills a DIFFERENT QuickBooks customer; rows for the
 * same customer (Sterling Auto Group owns S and T) may overlap freely. Returns the
 * conflicting dealer, or null when the prefix is safe (or absent).
 */
export function findPrefixConflict<T extends { id: string; stockPrefix: string | null; qbCustomerId?: string | null }>(
  prefix: string | null,
  candidate: { id?: string | null; qbCustomerId: string | null },
  dealers: T[],
): T | null {
  if (!prefix) return null
  const p = prefix.toUpperCase()
  for (const d of dealers) {
    if (candidate.id && d.id === candidate.id) continue
    const q = normalizeStock(d.stockPrefix)
    if (!q) continue
    if (!(p.startsWith(q) || q.startsWith(p))) continue
    if (candidate.qbCustomerId && d.qbCustomerId === candidate.qbCustomerId) continue
    return d
  }
  return null
}

/** dealer_scans free-text column limits — keep in sync with schema.ts. */
export const SCAN_TEXT_LIMITS = {
  vin: 17, vinSource: 20, stockNumber: 100, stockSource: 20,
  year: 4, make: 100, model: 100, color: 100, tagColor: 20, approvedBy: 200,
  rawBarcode: 100, qbLineId: 100, qbInvoiceNumber: 100,
} as const

/**
 * Clamp free text to a column's length limit (null-safe). OCR/VIN/typed values
 * can exceed a varchar limit and crash the INSERT with "value too long"; storing
 * a truncated value is always safer than losing the whole check-in.
 */
export function clampText(v: string | null | undefined, max: number): string | null {
  if (v == null) return null
  const s = String(v)
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Normalize a model year to a valid 4-char value. OCR occasionally merges digits
 * (e.g. "20268"), which overflows year varchar(4) and crashes the whole INSERT.
 * Prefers a plausible 19xx/20xx match, else the first 4 digits, else null.
 */
export function normalizeYear(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  const m = s.match(/(?:19|20)\d{2}/)
  const out = (m ? m[0] : s.replace(/\D/g, '')).slice(0, 4)
  return out || null
}

/**
 * Strip characters Postgres cannot store, so a jsonb/text write never throws
 * (NUL → jsonb SQLSTATE 22P05 "unsupported Unicode escape sequence"; NUL in
 * text → 22021). Removes C0 control chars and DEL and unpaired surrogates, but
 * PRESERVES tab / newline / carriage-return and valid (paired) Unicode.
 */
export function stripInvalidPgChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c === 0x09 || c === 0x0a || c === 0x0d) { out += ch; continue } // keep tab / LF / CR
    if (c <= 0x1f || c === 0x7f) continue                               // drop other C0 controls + DEL
    if (c >= 0xd800 && c <= 0xdfff) continue                            // drop lone surrogates
    out += ch
  }
  return out
}

/** Recursively strip invalid chars from every string in a JSON-ish value. */
function deepStripInvalid(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return stripInvalidPgChars(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((v) => deepStripInvalid(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepStripInvalid(v, depth + 1)
    return out
  }
  return null // functions / symbols / etc. are not JSON-storable
}

/** Meaningful OCR fields kept in the raw_ocr audit record — never the base64/
 * image/binary debug artifacts (stockDebugOverlayBase64, stockCropBase64, …). */
export const RAW_OCR_KEEP = [
  'stockNumber', 'year', 'make', 'model', 'modelName', 'color',
  'confidence', 'providerName', 'promptVersion',
] as const

/** Max serialized size for a stored raw_ocr payload (ample for OCR metadata). */
export const RAW_OCR_MAX_BYTES = 16 * 1024
/** Hard cap on the (optional) raw model response text. */
export const RAW_OCR_RESPONSE_MAX = 4 * 1024

/**
 * Reduce an OCR result to a compact, Postgres-safe audit record for raw_ocr:
 *  - keeps only the meaningful fields (drops base64/image/binary debug data),
 *  - includes the raw model response only if sanitized and reasonably sized,
 *  - strips  and other invalid control chars (keeps tab/newline),
 *  - caps total size so one scan can't create a multi-megabyte row.
 * Returns null when there is nothing meaningful to store.
 */
export function sanitizeRawOcr(raw: unknown, maxBytes = RAW_OCR_MAX_BYTES): Record<string, unknown> | null {
  if (raw == null || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const k of RAW_OCR_KEEP) {
    if (src[k] !== undefined) picked[k] = deepStripInvalid(src[k])
  }
  // Raw model response: free-form → strip invalid chars FIRST (so a real NUL is
  // removed as a character, not turned into a literal " " by JSON.stringify),
  // then flatten to a string and hard-cap the length.
  if (src.rawResponse !== undefined && src.rawResponse !== null) {
    const cleaned = deepStripInvalid(src.rawResponse)
    let s = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned)
    if (s.length > RAW_OCR_RESPONSE_MAX) s = s.slice(0, RAW_OCR_RESPONSE_MAX) + '…[truncated]'
    picked.rawResponse = s
  }
  // Final size guard: drop the only unbounded field first, then give up cleanly.
  if (JSON.stringify(picked).length > maxBytes) {
    delete picked.rawResponse
    if (JSON.stringify(picked).length > maxBytes) return { note: 'raw_ocr omitted: exceeded size limit' }
  }
  return Object.keys(picked).length ? picked : null
}

/** True when `stock` matches any already-present stock number. */
export function isDuplicateStock(existing: Array<string | null | undefined>, stock: string | null | undefined): boolean {
  const target = normalizeStock(stock)
  if (!target) return false
  return existing.some((e) => normalizeStock(e) === target)
}

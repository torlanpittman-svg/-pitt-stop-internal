/**
 * Business Receipts — AI extraction. Mirrors the proven Pitt Stop OS vision pattern (OpenAI GPT-4o,
 * temperature 0, JSON-only, fence-stripped parse) used by the Auto-Sales receipt reader and the
 * estimator. The output is a PROPOSAL a manager verifies — NEVER financial truth.
 *
 * Design rules honored here:
 *   - Extract only fields justified by the document; unreadable → null (never invented).
 *   - Never coerce a missing amount to $0 (parseCents keeps missing = null).
 *   - Integer cents for all money.
 *   - A field-level `present` map records which fields the model actually returned (uncertainty signal).
 *   - Degrades gracefully: on ANY error the caller gets status='failed' + an EMPTY proposal so the
 *     manager can enter the fields manually. Raw model output is kept private (audit only).
 */
import OpenAI from 'openai'
import { parseCents, categoryForLabel, type ExpenseCategory } from './types'

export const RECEIPT_PROMPT_VERSION = 'exp_v3'
// Bounded so a slow/hung provider call can never make capture "feel lost": the original is already saved,
// and a timed-out read surfaces as a recoverable failure the employee can retry or bypass with manual entry.
const EXTRACT_TIMEOUT_MS = 35_000
const EXTRACT_MAX_RETRIES = 0
const EXTRACT_MODEL = 'gpt-4o' // gpt-4o-mini tiles vision into 12–30× the tokens with no latency gain — measured

export interface ExpenseExtraction {
  vendor: string | null
  date: string | null            // YYYY-MM-DD
  subtotalCents: number | null
  taxCents: number | null
  shippingCents: number | null   // shipping / freight / delivery — a PART of the total, never added on top
  totalCents: number | null
  categoryLabel: string | null   // free-text model label (mapped to a coarse key downstream)
  categoryKey: ExpenseCategory   // normalized coarse category SUGGESTION ('uncategorized' when unknown)
  description: string | null     // short human summary of what was bought (drives the category suggestion)
  paymentMethod: string | null   // cash|card|check|ach|other|multiple (verbatim-ish; validated downstream)
  cardBrand: string | null       // visa|mastercard|discover|amex — ONLY when explicitly printed (payment-source match)
  paymentLast4: string | null    // the PAYMENT CARD's last 4 only (never an order#/date/terminal/auth/check#)
  accountEnding: string | null   // the PAYING BANK ACCOUNT's last 4, ONLY if explicitly printed as an account (never a check#)
  receiptNumber: string | null    // this document's receipt / invoice number
  orderNumber: string | null      // the vendor's ORDER / PO / confirmation number, when printed separately
  /** Which fields the model actually produced (a coarse per-field confidence/presence signal). */
  present: Record<'vendor' | 'date' | 'subtotal' | 'tax' | 'total' | 'category' | 'paymentMethod', boolean>
}
export interface ExpenseExtractResult { status: 'extracted' | 'failed'; model: string | null; raw: unknown; extraction: ExpenseExtraction }

export const EMPTY_EXTRACTION: ExpenseExtraction = {
  vendor: null, date: null, subtotalCents: null, taxCents: null, shippingCents: null, totalCents: null,
  categoryLabel: null, categoryKey: 'uncategorized', description: null, paymentMethod: null, cardBrand: null, paymentLast4: null, accountEnding: null, receiptNumber: null, orderNumber: null,
  present: { vendor: false, date: false, subtotal: false, tax: false, total: false, category: false, paymentMethod: false },
}

const PROMPT = `You are reading a BUSINESS EXPENSE RECEIPT or INVOICE (a photo, a PDF, or pasted email text) for an auto detailing shop and used-car dealership. Extract ONLY what is clearly legible; use null when unsure — do NOT guess. Return a STRICT JSON object with exactly these keys:
{
  "vendor": string|null,            // merchant / store name
  "date": "YYYY-MM-DD"|null,        // transaction / invoice date. Read ALL FOUR digits of the year exactly as printed; if the year is not clearly legible return null rather than guessing
  "subtotal": number|null,          // pre-tax, pre-shipping subtotal in dollars (absolute)
  "tax": number|null,               // tax in dollars (absolute); 0 if the document explicitly shows $0.00 tax
  "shipping": number|null,          // shipping / freight / delivery charge in dollars, ONLY if printed as its own line
  "total": number|null,             // grand total in dollars INCLUDING tax and shipping, ABSOLUTE value
  "category": string|null,          // a short expense category, e.g. "Parts", "Fuel", "Shop supplies", "Office", "Utilities"
  "description": string|null,       // 2-6 words naming the main items bought, e.g. "microfiber towels, wax" — helps pick a category
  "paymentMethod": "cash"|"card"|"check"|"ach"|"other"|"multiple"|null,  // how it was paid; "multiple" if more than one tender is shown
  "cardBrand": "visa"|"mastercard"|"discover"|"amex"|null,  // the card network, ONLY if explicitly printed
  "paymentLast4": string|null,      // last 4 of the PAYMENT CARD number ONLY, if visible — never an order#, date, terminal ID, auth code, or check number
  "accountEnding": string|null,     // last 4 of the PAYING BANK ACCOUNT, ONLY if the receipt explicitly prints it as a bank account (e.g. "ACCT ...2649"); a CHECK NUMBER is NOT an account ending — leave null
  "receiptNumber": string|null,     // this document's receipt/invoice number if visible
  "orderNumber": string|null        // the vendor's order / PO / confirmation number, ONLY if printed separately from the invoice number
}
Dollars as numbers (not strings, no $). Never invent a vendor, amount, tax, date, category, brand, card ending, or payment method. If a value is not clearly on the receipt, return null for it.`

function cleanDate(v: unknown): string | null { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null }
function cleanStr(v: unknown, max: number): string | null { return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null }

/**
 * PURE normalizer: turn the parsed model JSON into a validated proposal. Exported for deterministic
 * unit tests (missing fields → null, integer cents, `present` reflects real presence, category mapped).
 */
export function parseReceiptJson(j: unknown): ExpenseExtraction {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>
  const has = (v: unknown) => v !== null && v !== undefined && v !== ''
  const categoryLabel = cleanStr(o.category, 60)
  const description = cleanStr(o.description, 120)
  // Suggest a category from the explicit label first; fall back to the item description ("microfiber
  // towels" → shop supplies). Still only a SUGGESTION — the employee/manager confirms it.
  const categoryKey = categoryForLabel(categoryLabel) !== 'uncategorized' ? categoryForLabel(categoryLabel) : categoryForLabel(description)
  const rawPm = typeof o.paymentMethod === 'string' ? o.paymentMethod.trim().toLowerCase() : null
  const paymentMethod = rawPm && ['cash', 'card', 'check', 'ach', 'other', 'multiple'].includes(rawPm) ? rawPm : null
  const rawBrand = typeof o.cardBrand === 'string' ? o.cardBrand.trim().toLowerCase() : null
  const cardBrand = rawBrand && ['visa', 'mastercard', 'discover', 'amex'].includes(rawBrand) ? rawBrand : null
  return {
    vendor: cleanStr(o.vendor, 200),
    date: cleanDate(o.date),
    subtotalCents: parseCents(o.subtotal),
    taxCents: parseCents(o.tax),
    shippingCents: parseCents(o.shipping),
    totalCents: parseCents(o.total),
    categoryLabel,
    categoryKey,
    description,
    paymentMethod,
    cardBrand,
    paymentLast4: typeof o.paymentLast4 === 'string' ? (o.paymentLast4.match(/\d{4}/)?.[0] ?? null) : null,
    accountEnding: typeof o.accountEnding === 'string' ? (o.accountEnding.match(/\d{4}/)?.[0] ?? null) : null,
    receiptNumber: cleanStr(o.receiptNumber, 60),
    orderNumber: cleanStr(o.orderNumber, 60),
    present: {
      vendor: has(o.vendor), date: has(o.date), subtotal: has(o.subtotal), tax: has(o.tax),
      total: has(o.total), category: has(o.category) || has(o.description), paymentMethod: has(o.paymentMethod),
    },
  }
}

/**
 * Extract an expense receipt from image bytes (base64). Never throws — returns status='failed' on any error
 * (missing key, timeout, provider error, unparseable output). Two reliability fixes over the original:
 *   - response_format:json_object forces a valid JSON object (the model can't wrap it in prose/markdown),
 *     which was the silent cause of blank vendor/date/total — a stray fence made JSON.parse throw and the
 *     whole read was discarded. A guaranteed object also means a parse failure is a genuine provider fault,
 *     surfaced as a recoverable 'failed' (not swallowed).
 *   - a bounded timeout without automatic retries so a hung provider call cannot make capture hang; the original is
 *     already saved before this runs, so a timeout is recoverable through explicit retry, never lost work.
 */
/** The model input part for the stored evidence: a photo (vision), a PDF (file input), or pasted text. */
export function evidencePart(base64: string, mimeType: string): Record<string, unknown> {
  if (mimeType === 'application/pdf') return { type: 'file', file: { filename: 'receipt.pdf', file_data: `data:application/pdf;base64,${base64}` } }
  if (mimeType.startsWith('text/plain')) return { type: 'text', text: `RECEIPT TEXT (pasted) >>>\n${Buffer.from(base64, 'base64').toString('utf8')}\n<<< END OF RECEIPT TEXT` }
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } }
}

export async function extractExpense(imageBase64: string, mimeType: string): Promise<ExpenseExtractResult> {
  if (!process.env.OPENAI_API_KEY) return { status: 'failed', model: null, raw: { error: 'OPENAI_API_KEY not set' }, extraction: EMPTY_EXTRACTION }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: EXTRACT_TIMEOUT_MS, maxRetries: EXTRACT_MAX_RETRIES })
    const response = await client.chat.completions.create({
      model: EXTRACT_MODEL, max_tokens: 1200, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        evidencePart(imageBase64, mimeType),
        { type: 'text', text: PROMPT },
      ] as never }],
    })
    const content = response.choices[0]?.message?.content ?? ''
    // json_object guarantees a bare object; the fence-strip is kept only as a defensive no-op.
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const extraction = parseReceiptJson(JSON.parse(cleaned))
    // Keep only sanitized text (no PII beyond the receipt itself) — raw is audit-only, never logged.
    return { status: 'extracted', model: response.model, raw: { content }, extraction }
  } catch (err) {
    return { status: 'failed', model: null, raw: { error: String(err) }, extraction: EMPTY_EXTRACTION }
  }
}

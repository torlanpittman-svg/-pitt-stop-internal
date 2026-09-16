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

export const RECEIPT_PROMPT_VERSION = 'exp_v1'

export interface ExpenseExtraction {
  vendor: string | null
  date: string | null            // YYYY-MM-DD
  subtotalCents: number | null
  taxCents: number | null
  totalCents: number | null
  categoryLabel: string | null   // free-text model label (mapped to a coarse key downstream)
  categoryKey: ExpenseCategory   // normalized coarse category ('uncategorized' when unknown)
  paymentMethod: string | null   // cash|card|check|... (verbatim-ish; validated downstream)
  paymentLast4: string | null
  receiptNumber: string | null
  /** Which fields the model actually produced (a coarse per-field confidence/presence signal). */
  present: Record<'vendor' | 'date' | 'subtotal' | 'tax' | 'total' | 'category' | 'paymentMethod', boolean>
}
export interface ExpenseExtractResult { status: 'extracted' | 'failed'; model: string | null; raw: unknown; extraction: ExpenseExtraction }

export const EMPTY_EXTRACTION: ExpenseExtraction = {
  vendor: null, date: null, subtotalCents: null, taxCents: null, totalCents: null,
  categoryLabel: null, categoryKey: 'uncategorized', paymentMethod: null, paymentLast4: null, receiptNumber: null,
  present: { vendor: false, date: false, subtotal: false, tax: false, total: false, category: false, paymentMethod: false },
}

const PROMPT = `You are reading a photo of a BUSINESS EXPENSE RECEIPT or INVOICE for an auto detailing shop and used-car dealership. Extract ONLY what is clearly legible; use null when unsure — do NOT guess. Return STRICT JSON, no prose, no markdown fences:
{
  "vendor": string|null,            // merchant / store name
  "date": "YYYY-MM-DD"|null,        // transaction date
  "subtotal": number|null,          // pre-tax subtotal in dollars (absolute)
  "tax": number|null,               // tax in dollars (absolute)
  "total": number|null,             // grand total in dollars, ABSOLUTE value
  "category": string|null,          // a short expense category, e.g. "Parts", "Fuel", "Shop supplies", "Office", "Utilities"
  "paymentMethod": "cash"|"card"|"check"|"ach"|"other"|null,  // how it was paid, if shown
  "paymentLast4": string|null,      // last 4 of the card if visible
  "receiptNumber": string|null      // this document's receipt/invoice number if visible
}
Dollars as numbers (not strings, no $). Never invent a vendor, amount, tax, date, category, or payment method. If a value is not clearly on the receipt, return null for it.`

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
  const rawPm = typeof o.paymentMethod === 'string' ? o.paymentMethod.trim().toLowerCase() : null
  const paymentMethod = rawPm && ['cash', 'card', 'check', 'ach', 'other'].includes(rawPm) ? rawPm : null
  return {
    vendor: cleanStr(o.vendor, 200),
    date: cleanDate(o.date),
    subtotalCents: parseCents(o.subtotal),
    taxCents: parseCents(o.tax),
    totalCents: parseCents(o.total),
    categoryLabel,
    categoryKey: categoryForLabel(categoryLabel),
    paymentMethod,
    paymentLast4: typeof o.paymentLast4 === 'string' ? (o.paymentLast4.match(/\d{4}/)?.[0] ?? null) : null,
    receiptNumber: cleanStr(o.receiptNumber, 60),
    present: {
      vendor: has(o.vendor), date: has(o.date), subtotal: has(o.subtotal), tax: has(o.tax),
      total: has(o.total), category: has(o.category), paymentMethod: has(o.paymentMethod),
    },
  }
}

/** Extract an expense receipt from image bytes (base64). Never throws — returns status='failed' on any error. */
export async function extractExpense(imageBase64: string, mimeType: string): Promise<ExpenseExtractResult> {
  if (!process.env.OPENAI_API_KEY) return { status: 'failed', model: null, raw: { error: 'OPENAI_API_KEY not set' }, extraction: EMPTY_EXTRACTION }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const response = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 1200, temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
        { type: 'text', text: PROMPT },
      ] as never }],
    })
    const content = response.choices[0]?.message?.content ?? ''
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const extraction = parseReceiptJson(JSON.parse(cleaned))
    // Keep only sanitized text (no PII beyond the receipt itself) — raw is audit-only, never logged.
    return { status: 'extracted', model: response.model, raw: { content }, extraction }
  } catch (err) {
    return { status: 'failed', model: null, raw: { error: String(err) }, extraction: EMPTY_EXTRACTION }
  }
}

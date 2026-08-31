/**
 * Auto-Sales B2 — receipt AI extraction. Mirrors the proven Pitt Stop OS vision pattern (OpenAI
 * GPT-4o, temperature 0, JSON-only, fence-stripped parse) used by the estimator + dealer OCR. Output
 * is a PROPOSAL the employee verifies — never financial truth. Friendly categories map onto the
 * existing Auto-Sales economic categories (no separate category system). Degrades gracefully: on any
 * error the caller gets aiStatus='failed' and the employee enters the minimum fields manually.
 */
import OpenAI from 'openai'
import { RECEIPT_CATEGORIES } from '../types'

export const RECEIPT_PROMPT_VERSION = 'v1'

export interface ReceiptLineItem { description: string; amountCents: number | null }
export interface ReceiptExtraction {
  vendor: string | null
  date: string | null            // YYYY-MM-DD
  totalCents: number | null
  subtotalCents: number | null
  taxCents: number | null
  categoryLabel: string | null   // one of RECEIPT_CATEGORIES labels
  lineItems: ReceiptLineItem[]
  paymentLast4: string | null
  receiptNumber: string | null
  isReturn: boolean              // AI thinks this is a return/refund/credit doc
}
export interface ReceiptExtractResult { status: 'extracted' | 'failed'; model: string | null; raw: unknown; extraction: ReceiptExtraction }

const EMPTY: ReceiptExtraction = { vendor: null, date: null, totalCents: null, subtotalCents: null, taxCents: null, categoryLabel: null, lineItems: [], paymentLast4: null, receiptNumber: null, isReturn: false }

const PROMPT = `You are reading a photo of a vehicle-shop purchase RECEIPT or INVOICE. Extract ONLY what is clearly legible; use null when unsure. Return STRICT JSON, no prose, no markdown fences:
{
  "vendor": string|null,                 // merchant / store name
  "date": "YYYY-MM-DD"|null,             // transaction date
  "total": number|null,                  // grand total in dollars (e.g. 186.42)
  "subtotal": number|null,               // pre-tax subtotal in dollars
  "tax": number|null,                    // tax in dollars
  "category": one of ["Parts","Mechanical / Labor","Body / Paint","PDR","Tires / Wheels","Transport / Towing","Detail / Recon","Title / Registration","Auction / Purchase Fees","Fuel","Other"]|null,
  "lineItems": [ { "description": string, "amount": number|null } ],   // in dollars; [] if not clearly readable
  "paymentLast4": string|null,           // last 4 of card if visible
  "receiptNumber": string|null,          // receipt / invoice number if visible
  "isReturn": boolean                    // true if this is a return, refund, or credit memo (negative/"CREDIT"/"RETURN")
}
Rules: dollars as numbers (not strings, no $). If the total is unreadable, set total to null. Pick the single best category. Do not invent line items.`

function dollarsToCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
function cleanDate(v: unknown): string | null { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null }

/** Extract a receipt from image bytes (base64). Never throws — returns status='failed' on any error. */
export async function extractReceipt(imageBase64: string, mimeType: string): Promise<ReceiptExtractResult> {
  if (!process.env.OPENAI_API_KEY) return { status: 'failed', model: null, raw: { error: 'OPENAI_API_KEY not set' }, extraction: EMPTY }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const response = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 1200, temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
        { type: 'text', text: PROMPT },
      ] as any }],
    })
    const content = response.choices[0]?.message?.content ?? ''
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const j = JSON.parse(cleaned) as any
    const extraction: ReceiptExtraction = {
      vendor: typeof j.vendor === 'string' && j.vendor.trim() ? j.vendor.trim().slice(0, 200) : null,
      date: cleanDate(j.date),
      totalCents: dollarsToCents(j.total),
      subtotalCents: dollarsToCents(j.subtotal),
      taxCents: dollarsToCents(j.tax),
      categoryLabel: RECEIPT_CATEGORIES.some((c) => c.label === j.category) ? j.category : null,
      lineItems: Array.isArray(j.lineItems) ? j.lineItems.slice(0, 30).map((li: any) => ({ description: String(li?.description ?? '').slice(0, 200), amountCents: dollarsToCents(li?.amount) })).filter((li: ReceiptLineItem) => li.description) : [],
      paymentLast4: typeof j.paymentLast4 === 'string' ? (j.paymentLast4.match(/\d{4}/)?.[0] ?? null) : null,
      receiptNumber: typeof j.receiptNumber === 'string' && j.receiptNumber.trim() ? j.receiptNumber.trim().slice(0, 60) : null,
      isReturn: Boolean(j.isReturn),
    }
    return { status: 'extracted', model: response.model, raw: { content }, extraction }
  } catch (err) {
    return { status: 'failed', model: null, raw: { error: String(err) }, extraction: EMPTY }
  }
}

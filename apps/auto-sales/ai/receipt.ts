/**
 * Auto-Sales B2 — receipt AI extraction. Mirrors the proven Pitt Stop OS vision pattern (OpenAI
 * GPT-4o, temperature 0, JSON-only, fence-stripped parse) used by the estimator + dealer OCR. Output
 * is a PROPOSAL the employee verifies — never financial truth. Friendly categories map onto the
 * existing Auto-Sales economic categories (no separate category system). Degrades gracefully: on any
 * error the caller gets aiStatus='failed' and the employee enters the minimum fields manually.
 */
import OpenAI from 'openai'
import { RECEIPT_CATEGORIES, isReturnDocType, type DocumentType } from '../types'

export const RECEIPT_PROMPT_VERSION = 'v2'

// A line item is now richer so partial returns can be matched to a specific prior part later. All fields
// are best-effort (null when illegible). `returned` = this specific line reads as a returned/credited line.
export interface ReceiptLineItem {
  description: string
  amountCents: number | null      // line total (absolute value)
  quantity: number | null
  unitPriceCents: number | null
  sku: string | null              // part / SKU number if visible
  returned: boolean               // this line is marked returned/credited on the doc
}
export interface ReceiptExtraction {
  vendor: string | null
  date: string | null            // YYYY-MM-DD
  totalCents: number | null      // absolute value (sign carried by documentType/isReturn)
  subtotalCents: number | null
  taxCents: number | null
  categoryLabel: string | null   // one of RECEIPT_CATEGORIES labels
  lineItems: ReceiptLineItem[]
  paymentLast4: string | null
  receiptNumber: string | null   // this document's own receipt/invoice number
  documentType: DocumentType     // purchase | return | partial_return | refund | store_credit | unknown
  originalReference: string | null // for a return: the ORIGINAL receipt/invoice # it references, if cited
  isReturn: boolean              // derived: documentType is a return/refund/credit OR a negative total
}
export interface ReceiptExtractResult { status: 'extracted' | 'failed'; model: string | null; raw: unknown; extraction: ReceiptExtraction }

const EMPTY: ReceiptExtraction = { vendor: null, date: null, totalCents: null, subtotalCents: null, taxCents: null, categoryLabel: null, lineItems: [], paymentLast4: null, receiptNumber: null, documentType: 'unknown', originalReference: null, isReturn: false }

const PROMPT = `You are reading a photo of a vehicle-shop RECEIPT, INVOICE, RETURN or CREDIT MEMO. Extract ONLY what is clearly legible; use null when unsure. Return STRICT JSON, no prose, no markdown fences:
{
  "vendor": string|null,                 // merchant / store name
  "date": "YYYY-MM-DD"|null,             // transaction date
  "total": number|null,                  // grand total in dollars, ABSOLUTE value (e.g. 186.42) even if the doc shows it negative
  "subtotal": number|null,               // pre-tax subtotal in dollars (absolute)
  "tax": number|null,                    // tax in dollars (absolute)
  "category": one of ["Parts","Mechanical / Labor","Body / Paint","PDR","Tires / Wheels","Transport / Towing","Detail / Recon","Title / Registration","Auction / Purchase Fees","Fuel","Other"]|null,
  "lineItems": [ { "description": string, "amount": number|null, "quantity": number|null, "unitPrice": number|null, "sku": string|null, "returned": boolean } ],  // dollars, absolute; sku = part number if printed; returned=true only if THIS line is a returned/credit line
  "paymentLast4": string|null,           // last 4 of card if visible
  "receiptNumber": string|null,          // THIS document's receipt/invoice number if visible
  "documentType": "purchase"|"return"|"partial_return"|"refund"|"store_credit"|"unknown",  // classify the whole document
  "originalReference": string|null       // if this is a return, the ORIGINAL receipt/invoice number it references (else null)
}
Classification guidance: "return"/"partial_return" = merchandise returned (may cite an original receipt); "refund" = money refunded (card/cash); "store_credit" = credit issued to a store/vendor account (NOT money back to a card); "purchase" = normal buy; "unknown" if unclear. Negative totals, "CREDIT", "RETURN", "REFUND", or parenthesized amounts indicate a return/credit document. Dollars as numbers (not strings, no $). Pick the single best category. Do not invent line items.`

function dollarsToCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : NaN
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null   // absolute; sign carried by documentType
}
function toQty(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}
function cleanDate(v: unknown): string | null { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null }
function cleanRef(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null }

/** Extract a receipt from image bytes (base64). Never throws — returns status='failed' on any error. */
export async function extractReceipt(imageBase64: string, mimeType: string): Promise<ReceiptExtractResult> {
  if (!process.env.OPENAI_API_KEY) return { status: 'failed', model: null, raw: { error: 'OPENAI_API_KEY not set' }, extraction: EMPTY }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const response = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 1500, temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
        { type: 'text', text: PROMPT },
      ] as any }],
    })
    const content = response.choices[0]?.message?.content ?? ''
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const j = JSON.parse(cleaned) as any
    const documentType: DocumentType = ['purchase', 'return', 'partial_return', 'refund', 'store_credit', 'unknown'].includes(j.documentType) ? j.documentType : 'unknown'
    const rawTotal = typeof j.total === 'number' ? j.total : typeof j.total === 'string' ? parseFloat(j.total.replace(/[^0-9.\-]/g, '')) : NaN
    const negativeTotal = Number.isFinite(rawTotal) && rawTotal < 0
    const extraction: ReceiptExtraction = {
      vendor: typeof j.vendor === 'string' && j.vendor.trim() ? j.vendor.trim().slice(0, 200) : null,
      date: cleanDate(j.date),
      totalCents: dollarsToCents(j.total),
      subtotalCents: dollarsToCents(j.subtotal),
      taxCents: dollarsToCents(j.tax),
      categoryLabel: RECEIPT_CATEGORIES.some((c) => c.label === j.category) ? j.category : null,
      lineItems: Array.isArray(j.lineItems) ? j.lineItems.slice(0, 30).map((li: any) => ({
        description: String(li?.description ?? '').slice(0, 200),
        amountCents: dollarsToCents(li?.amount),
        quantity: toQty(li?.quantity),
        unitPriceCents: dollarsToCents(li?.unitPrice),
        sku: typeof li?.sku === 'string' && li.sku.trim() ? li.sku.trim().slice(0, 60) : null,
        returned: Boolean(li?.returned),
      })).filter((li: ReceiptLineItem) => li.description) : [],
      paymentLast4: typeof j.paymentLast4 === 'string' ? (j.paymentLast4.match(/\d{4}/)?.[0] ?? null) : null,
      receiptNumber: cleanRef(j.receiptNumber),
      documentType,
      originalReference: cleanRef(j.originalReference),
      isReturn: isReturnDocType(documentType) || negativeTotal || (Boolean(j.isReturn)),
    }
    return { status: 'extracted', model: response.model, raw: { content }, extraction }
  } catch (err) {
    return { status: 'failed', model: null, raw: { error: String(err) }, extraction: EMPTY }
  }
}

import type { FundingSource, PaymentMethod } from './types'

// Operational source references only, not QuickBooks account IDs. The existing account_ref is 40 chars.
export const OTHER_PAYMENT_MAX_LENGTH = 34
export const RECEIPT_PAYMENT_CHOICES = [
  { key: 'amb_debit', label: 'AMB debit card', funding: 'business', method: 'card', accountRef: '*2649' },
  { key: 'amb_check', label: 'AMB *2649 check', funding: 'business', method: 'check', accountRef: '*2649' },
  { key: 'extraco_debit', label: 'Extraco debit card', funding: 'business', method: 'card', accountRef: '*5600' },
  { key: 'extraco_check', label: 'Extraco *5600 check', funding: 'business', method: 'check', accountRef: '*5600' },
  { key: 'cash', label: 'Cash', funding: 'business', method: 'cash', accountRef: 'cash' },
  { key: 'personal', label: 'Personal', funding: 'personal', method: null, accountRef: null },
  { key: 'other', label: 'Other', funding: 'unknown', method: null, accountRef: null },
] as const

export interface ReceiptPayment {
  funding: FundingSource
  paymentMethod: PaymentMethod | null
  accountRef: string | null
}

export function resolveReceiptPayment(choice: unknown, other: unknown = ''):
  { ok: true; payment: ReceiptPayment } | { ok: false; error: string } {
  // Preserve unpaid as an explicit secondary option; it is not a bank or a payment method.
  if (choice === 'unpaid') return { ok: true, payment: { funding: 'unpaid', paymentMethod: null, accountRef: null } }
  const selected = RECEIPT_PAYMENT_CHOICES.find((p) => p.key === choice)
  if (!selected) return { ok: false, error: 'Choose how this was paid.' }
  if (choice === 'other') {
    const description = typeof other === 'string' ? other.trim() : ''
    if (!description || description.length > OTHER_PAYMENT_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(description)) {
      return { ok: false, error: `Describe the payment source in 1–${OTHER_PAYMENT_MAX_LENGTH} characters.` }
    }
    // Unknown funding requires clarification; free text must never assert business-account cash flow.
    return { ok: true, payment: { funding: 'unknown', paymentMethod: null, accountRef: `other:${description}` } }
  }
  return { ok: true, payment: { funding: selected.funding, paymentMethod: selected.method, accountRef: selected.accountRef } }
}

export function receiptPaymentChoice(r: { funding: string; paymentMethod: string | null; accountRef: string | null }): string {
  if (r.funding === 'personal' || r.funding === 'unpaid') return r.funding
  if (r.accountRef?.startsWith('other:')) return 'other'
  return RECEIPT_PAYMENT_CHOICES.find((p) => p.key !== 'other' && p.funding === r.funding && p.method === r.paymentMethod && p.accountRef === r.accountRef)?.key ?? ''
}

export function receiptPaymentLabel(r: { funding: string; paymentMethod: string | null; accountRef: string | null }): string {
  const choice = receiptPaymentChoice(r)
  if (choice === 'other') return `Other: ${r.accountRef!.slice(6)}`
  if (choice === 'unpaid') return 'Not paid yet'
  const selected = RECEIPT_PAYMENT_CHOICES.find((p) => p.key === choice)
  if (selected) return selected.label
  // Historical generic card/check entries must not be retroactively assigned a bank.
  return [r.accountRef && r.accountRef !== 'unknown' ? r.accountRef : 'Account not specified', r.paymentMethod].filter(Boolean).join(' · ')
}

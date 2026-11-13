/**
 * Bank-transaction class helpers — PURE (no DB). The classes themselves are assigned at ingest by
 * classifyTxn (./transactions.ts); these only answer what a class MEANS for receipts.
 */

// Cash movements that are never the purchase itself. A card payment pays for many earlier card purchases; a
// transfer / owner draw moves money between accounts; payroll and loan payments have their own records.
// Matching a receipt to one of these is how a card purchase and its later card payment would both be counted.
const NON_PURCHASE_CLASSES = new Set(['card_payment', 'transfer', 'owner_draw', 'payroll', 'debt_payment', 'refund', 'settlement', 'deposit'])

/** Can a receipt stand behind a transaction of this class? (an unclassified transaction is allowed) */
export function isPurchaseTxnClass(txnClass: string | null | undefined): boolean {
  return !NON_PURCHASE_CLASSES.has(txnClass ?? '')
}

/** Bank classes where a receipt is normally expected (a bank fee has no receipt). */
export function expectsReceipt(txnClass: string | null | undefined): boolean {
  return txnClass === 'expense' || txnClass === 'inventory' || txnClass === 'check'
}

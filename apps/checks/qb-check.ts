/**
 * QuickBooks WRITE/READ for physical checks.
 *
 * A hand-written business check paying an expense directly from a bank account is recorded in QBO as a
 * **Purchase** with `PaymentType: "Check"`:
 *   - AccountRef      → the BANK account the money leaves (credit)                 [operating *2649]
 *   - EntityRef       → the payee: a Vendor, Employee or Customer (id + type)       [top-level payee]
 *   - DocNumber       → the physical check number                                   [our reserved number]
 *   - Line[]          → AccountBasedExpenseLineDetail with AccountRef = expense account (debit)
 *   - PrivateNote     → the memo/purpose (also printed on the check)
 * This is NOT a BillPaymentCheck (that pays an existing A/P Bill) and NOT an Invoice (A/R). It is the
 * correct entity for "Pitt Stop directly pays an expense with a physical check from operating checking."
 *
 * Builds on the shared authenticated client (apps/quickbooks/client). Reuses the same prod/sandbox
 * fail-closed protections as every other QB call (the client targets whichever realm the active
 * connection authorizes; the CFO read model already filters sandbox out of production truth).
 */
import { qbApiRequest, queryQBO, qboEscape } from '@/apps/quickbooks/client'
import { logger } from '@/platform/logger'
import type { PayeeType } from './payee'

const APP = 'checks:qb-check'
const centsToDollars = (c: number) => Math.round(c) / 100

export interface WrittenCheck {
  purchaseId: string
  docNumber: string | null
  syncToken: string
  totalCents: number
  bankAccountId: string | null   // AccountRef — the bank account the Purchase draws from
  vendorId: string | null        // EntityRef.value — the payee id (Vendor, Employee or Customer)
  payeeType: string | null       // EntityRef.type
  txnDate: string | null         // YYYY-MM-DD
}

interface QbPurchase { Id: string; DocNumber?: string; SyncToken: string; TotalAmt?: number; TxnDate?: string; PaymentType?: string; AccountRef?: { value?: string }; EntityRef?: { value?: string; type?: string } }

function summarize(p: QbPurchase): WrittenCheck {
  return {
    purchaseId: p.Id, docNumber: p.DocNumber ?? null, syncToken: p.SyncToken, totalCents: Math.round((p.TotalAmt ?? 0) * 100),
    bankAccountId: p.AccountRef?.value ?? null, vendorId: p.EntityRef?.value ?? null, payeeType: p.EntityRef?.type ?? null, txnDate: p.TxnDate ?? null,
  }
}

export interface CreateCheckParams {
  bankAccountId: string
  expenseAccountId: string
  vendorId: string         // the payee's QuickBooks id
  payeeType: PayeeType     // which QuickBooks list that id belongs to
  amountCents: number
  docNumber: string        // the reserved physical check number
  txnDate: string          // YYYY-MM-DD
  memo?: string | null
  lineDescription?: string | null
  /** Stable per-check id sent as QuickBooks `requestid`, so a replayed create returns the ORIGINAL
   *  response instead of creating a second Purchase. */
  requestId?: string | null
}

/**
 * Create the Purchase/Check in QuickBooks. Idempotency is the CALLER's responsibility (never call this
 * when the check record already has a qbo_txn_id) — plus findCheckByDocNumber() below lets the service
 * adopt a check that QB created if the local commit was lost. Throws QBApiError on failure so the caller
 * keeps the check un-recorded and never prints a negotiable check for a failed write.
 */
export async function createCheckInQB(p: CreateCheckParams): Promise<WrittenCheck> {
  const amount = centsToDollars(p.amountCents)
  const body: Record<string, unknown> = {
    PaymentType: 'Check',
    AccountRef: { value: p.bankAccountId },
    EntityRef: { value: p.vendorId, type: p.payeeType },
    DocNumber: p.docNumber,
    TxnDate: p.txnDate,
    Line: [
      {
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: amount,
        Description: p.lineDescription?.trim() || p.memo?.trim() || undefined,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: p.expenseAccountId },
        },
      },
    ],
  }
  if (p.memo && p.memo.trim()) body.PrivateNote = p.memo.trim()

  const res = await qbApiRequest<{ Purchase: QbPurchase }>({ method: 'POST', path: '/purchase', body, ...(p.requestId ? { query: { requestid: p.requestId } } : {}) })
  logger.info(APP, 'check.created', { id: res.Purchase.Id, docNumber: res.Purchase.DocNumber })
  return summarize(res.Purchase)
}

/** Every Purchase/Check QuickBooks already holds with this exact DocNumber (any bank account). */
export async function findChecksByDocNumber(docNumber: string): Promise<WrittenCheck[]> {
  const res = await queryQBO<{ Purchase?: QbPurchase[] }>(
    `SELECT * FROM Purchase WHERE DocNumber = '${qboEscape(docNumber)}'`,
  )
  return (res.Purchase ?? []).filter((p) => p.PaymentType === 'Check').map(summarize)
}

export interface ExpectedCheck { bankAccountId: string; vendorId: string; payeeType: PayeeType; amountCents: number; txnDate: string }
export type RecoveryDecision =
  | { action: 'create' }                       // nothing on this bank account uses the number
  | { action: 'adopt'; check: WrittenCheck }   // exactly one Purchase is unmistakably OUR earlier attempt
  | { action: 'conflict'; reason: string }     // the number is taken by something else — never guess

/**
 * Crash-recovery decision (pure). A prior attempt may have reached QuickBooks without us recording it, so
 * before creating we look for the check number. We adopt ONLY a Purchase that matches this check on bank
 * account + payee (id AND type — ids are only unique within one QuickBooks list) + amount + date. A
 * check with the same number on the SAME bank account that differs in any of those is somebody else's
 * transaction: fail closed rather than attach to it or duplicate the number. The same number on a
 * DIFFERENT bank account is unrelated (separate check stock).
 */
export function decideRecovery(found: WrittenCheck[], expected: ExpectedCheck): RecoveryDecision {
  const sameBank = found.filter((f) => f.bankAccountId === expected.bankAccountId)
  if (sameBank.length === 0) return { action: 'create' }
  const exact = sameBank.filter((f) => f.vendorId === expected.vendorId && (f.payeeType ?? 'Vendor') === expected.payeeType && f.totalCents === expected.amountCents && f.txnDate === expected.txnDate)
  if (exact.length === 1 && sameBank.length === 1) return { action: 'adopt', check: exact[0] }
  if (exact.length > 1) return { action: 'conflict', reason: `QuickBooks already has ${exact.length} identical checks with this number on this bank account` }
  return { action: 'conflict', reason: 'QuickBooks already has a different check with this number on this bank account' }
}

export interface QbAccount { id: string; name: string; type: string; subType: string | null; acctNumMask: string | null; active: boolean }

// Mask any 5+ digit run so a real bank account number can never be returned to the client/logs.
const maskAcct = (s?: string | null) => (s ? String(s).replace(/\d{5,}/g, (m) => '****' + m.slice(-4)) : null)

/** READ-ONLY list of accounts of a given AccountType — for the owner setup screen (bank + expense pick). */
export async function listAccounts(accountType: 'Bank' | 'Expense'): Promise<QbAccount[]> {
  const res = await queryQBO<{ Account?: Array<{ Id: string; Name: string; AccountType?: string; AccountSubType?: string; AcctNum?: string; Active?: boolean }> }>(
    `SELECT * FROM Account WHERE AccountType = '${accountType}' MAXRESULTS 200`,
  )
  return (res.Account ?? []).map((a) => ({
    id: a.Id, name: a.Name, type: a.AccountType ?? accountType, subType: a.AccountSubType ?? null,
    acctNumMask: maskAcct(a.AcctNum), active: a.Active !== false,
  }))
}

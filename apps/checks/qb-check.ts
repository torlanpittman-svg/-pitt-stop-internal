/**
 * QuickBooks WRITE/READ for physical checks.
 *
 * A hand-written business check paying an expense directly from a bank account is recorded in QBO as a
 * **Purchase** with `PaymentType: "Check"`:
 *   - AccountRef      → the BANK account the money leaves (credit)                 [operating *2649]
 *   - EntityRef       → the payee (Vendor)                                          [top-level payee]
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

const APP = 'checks:qb-check'
const centsToDollars = (c: number) => Math.round(c) / 100

export interface WrittenCheck {
  purchaseId: string
  docNumber: string | null
  syncToken: string
  totalCents: number
}

function summarize(p: { Id: string; DocNumber?: string; SyncToken: string; TotalAmt?: number }): WrittenCheck {
  return { purchaseId: p.Id, docNumber: p.DocNumber ?? null, syncToken: p.SyncToken, totalCents: Math.round((p.TotalAmt ?? 0) * 100) }
}

export interface CreateCheckParams {
  bankAccountId: string
  expenseAccountId: string
  vendorId: string
  amountCents: number
  docNumber: string        // the reserved physical check number
  txnDate: string          // YYYY-MM-DD
  memo?: string | null
  lineDescription?: string | null
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
    EntityRef: { value: p.vendorId, type: 'Vendor' },
    DocNumber: p.docNumber,
    TxnDate: p.txnDate,
    Line: [
      {
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: amount,
        Description: p.lineDescription?.trim() || p.memo?.trim() || undefined,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: p.expenseAccountId },
          EntityRef: { value: p.vendorId, type: 'Vendor' },
        },
      },
    ],
  }
  if (p.memo && p.memo.trim()) body.PrivateNote = p.memo.trim()

  const res = await qbApiRequest<{ Purchase: Parameters<typeof summarize>[0] }>({ method: 'POST', path: '/purchase', body })
  logger.info(APP, 'check.created', { id: res.Purchase.Id, docNumber: res.Purchase.DocNumber })
  return summarize(res.Purchase)
}

/** Adoption / crash-safety: find a Purchase/Check already recorded with this exact DocNumber. */
export async function findCheckByDocNumber(docNumber: string): Promise<WrittenCheck | null> {
  const res = await queryQBO<{ Purchase?: Array<Parameters<typeof summarize>[0] & { PaymentType?: string }> }>(
    `SELECT * FROM Purchase WHERE DocNumber = '${qboEscape(docNumber)}'`,
  )
  const hit = (res.Purchase ?? []).find((p) => p.PaymentType === 'Check')
  return hit ? summarize(hit) : null
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

/**
 * CFO Phase 2 — transaction ingestion + cash-integrity classification.
 *
 * Pulls Plaid transactions (read-only) for CONNECTED + ACTIVE accounts only (ignored/closed
 * connector accounts never enter the CFO). Normalizes them and classifies each so cash movement
 * is never double-counted: a transfer or a bank→credit-card payment is NOT an operating expense,
 * and the individual card charges (which live on the Amex item) are the real expenses.
 *
 * Classification is ADVISORY — it carries confidence + evidence and never rewrites a balance.
 * Safe-to-Spend uses the bank's own available balance, so these labels feed analysis / recurring
 * discovery / payroll inference, not the cash figure itself.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { decrypt } from '@/apps/quickbooks/crypto'
import { finPlaidItems, finPlaidAccounts, finTransactions, finEvents } from './schema'
import { transactionsSync, type PlaidTxn } from './plaid'

export type TxnClass =
  | 'expense' | 'deposit' | 'transfer' | 'card_payment' | 'debt_payment'
  | 'check' | 'payroll' | 'owner_draw' | 'refund' | 'inventory' | 'settlement' | 'fee' | 'other'

export interface Classification { txnClass: TxnClass; isExpense: boolean; isCashMovement: boolean; confidence: 'rule' | 'heuristic'; evidence: string }

const rx = (s: string, re: RegExp) => re.test(s)

// Confirmed weekly net paycheck amounts (cents) from QuickBooks Payroll (owner-verified 2026-08-26):
// Torlan 1572.45, Anthony 1006.12, Darryl 461.75. Paper checks clear as "Check(C## Inclearings)"
// which Plaid mislabels TRANSFER_OUT — we identify them by these exact amounts.
const PAYROLL_NET_CENTS = new Set([157245, 100612, 46175])
const OWNER_DRAW_CENTS = 100000 // Darryl's $1,000/wk owner distribution → *0169 (personal)

/**
 * Rule-based classifier. Priority order matters: liability/transfer movements are caught before the
 * generic expense/deposit fallback so they are never counted as opex.
 */
export function classifyTxn(t: PlaidTxn): Classification {
  const out = t.amount > 0            // Plaid: positive = money OUT of the account
  const inflow = t.amount < 0
  const name = `${t.name ?? ''} ${t.merchant_name ?? ''}`.toLowerCase()
  const pfcP = (t.personal_finance_category?.primary ?? '').toUpperCase()
  const pfcD = (t.personal_finance_category?.detailed ?? '').toUpperCase()
  const channel = (t.payment_channel ?? '').toLowerCase()
  const checkNo = t.payment_meta?.check_number ?? null
  const amt = Math.abs(Math.round(t.amount * 100))
  const isCheck = Boolean(checkNo) || rx(name, /check\(|\bcheck\b|\bchk\b|\bcheque\b|clearing|e-?check\b/)
  const toPersonal = rx(name, /0169|to checking xx?0169/) // Darryl's personal account

  // 0a) Owner distribution — Darryl's recurring $1,000 to *0169 (equity cash-out, NOT payroll/expense).
  if (out && amt === OWNER_DRAW_CENTS && (toPersonal || rx(name, /to checking/)))
    return { txnClass: 'owner_draw', isExpense: false, isCashMovement: true, confidence: toPersonal ? 'rule' : 'heuristic', evidence: 'to *0169 $1,000 owner draw' }

  // 0b) Employee payroll — paper checks matching a confirmed net amount (Plaid mislabels these
  // TRANSFER_OUT, so catch them first). Critical committed obligation; not an operating expense line.
  if (out && isCheck && PAYROLL_NET_CENTS.has(amt))
    return { txnClass: 'payroll', isExpense: false, isCashMovement: true, confidence: 'rule', evidence: `payroll net check $${(amt / 100).toFixed(2)}` }

  // 1) Bank → credit-card payment (NOT an expense; the card charges are the expenses).
  if (out && (pfcD === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' ||
      rx(name, /\b(amex|american express|cardmember serv|card member|credit crd|credit card|chase card|capital one|discover)\b.*\b(payment|epayment|e-payment|ach pmt|autopay|pmt|bill)\b/) ||
      rx(name, /\bautopay\b.*\bcard\b/) || rx(name, /payment thank you/)))
    return { txnClass: 'card_payment', isExpense: false, isCashMovement: true, confidence: pfcD === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' ? 'rule' : 'heuristic', evidence: pfcD || 'name~card payment' }

  // 2) Payroll out (own its category — critical committed obligation, not opex line).
  if (out && rx(name, /\b(payroll|gusto|adp|paychex|paylocity|intuit.*payroll|quickbooks.*payroll|qb payroll|direct dep|dir dep|net pay|wages|employee pay)\b/))
    return { txnClass: 'payroll', isExpense: false, isCashMovement: true, confidence: 'heuristic', evidence: 'name~payroll' }

  // 3) Debt / loan payment (non-card) — committed, tracked as debt service not opex.
  if (out && (pfcP === 'LOAN_PAYMENTS' || rx(name, /\b(loan|note pmt|floor ?plan|nmac|ally financial|term loan|sba|principal|installment|lien)\b/)))
    return { txnClass: 'debt_payment', isExpense: false, isCashMovement: true, confidence: pfcP === 'LOAN_PAYMENTS' ? 'rule' : 'heuristic', evidence: pfcP === 'LOAN_PAYMENTS' ? pfcP : 'name~loan' }

  // 3b) Cleared paper check (vendor/other). Runs BEFORE transfer because this bank clears checks as
  // "Check(C## Inclearings)" which Plaid mislabels TRANSFER_OUT. A true "From Checking XX→XX" transfer
  // has no "check("/"clearing"/check-number and is caught by rule 4. Non-payroll checks are expenses.
  if (out && isCheck && !rx(name, /from checking|to checking/))
    return { txnClass: 'check', isExpense: true, isCashMovement: false, confidence: checkNo ? 'rule' : 'heuristic', evidence: checkNo ? `check #${checkNo}` : 'name~check/clearing' }

  // 4) Internal / account transfer (cash moves, not an expense; avoid double count across accounts).
  if (pfcP === 'TRANSFER_IN' || pfcP === 'TRANSFER_OUT' ||
      rx(name, /\b(transfer|xfer|to (checking|savings|share)|from (checking|savings|share)|online banking transfer|book transfer|internal transfer|acct xfer|zelle|venmo|move money)\b/))
    return { txnClass: 'transfer', isExpense: false, isCashMovement: true, confidence: (pfcP.startsWith('TRANSFER')) ? 'rule' : 'heuristic', evidence: pfcP.startsWith('TRANSFER') ? pfcP : 'name~transfer' }

  // 5) Refund / reversal (inflow, not income from operations).
  if (inflow && (rx(pfcD, /REFUND/) || rx(name, /\b(refund|reversal|return|credit adj|chargeback reversal)\b/)))
    return { txnClass: 'refund', isExpense: false, isCashMovement: false, confidence: 'heuristic', evidence: 'inflow~refund' }

  // 6) Merchant / card-processor settlement (operating income inflow).
  if (inflow && rx(name, /\b(clover|stripe|square|toast|worldpay|fiserv|tsys|global pay|elavon|merch(ant)? (dep|settle|bankcard|svc)|card ?settle|bankcard|payment processing|cardservice|deposit)\b/))
    return { txnClass: 'settlement', isExpense: false, isCashMovement: false, confidence: 'heuristic', evidence: 'inflow~processor/deposit' }

  // 7) Any other inflow → deposit / income.
  if (inflow)
    return { txnClass: 'deposit', isExpense: false, isCashMovement: false, confidence: pfcP === 'INCOME' ? 'rule' : 'heuristic', evidence: pfcP === 'INCOME' ? pfcP : 'inflow' }

  // 8) Bank fee.
  if (out && (pfcP === 'BANK_FEES' || rx(name, /\b(overdraft|nsf|service charge|monthly fee|wire fee|maintenance fee|returned item|analysis charge)\b/)))
    return { txnClass: 'fee', isExpense: true, isCashMovement: false, confidence: pfcP === 'BANK_FEES' ? 'rule' : 'heuristic', evidence: pfcP === 'BANK_FEES' ? pfcP : 'name~fee' }

  // 10) Inventory / parts (best-effort supplier match).
  if (out && rx(name, /\b(napa|autozone|o'?reilly|advance auto|worldpac|keystone|lkq|parts authority|3m|chemical guys|detail supply|meguiar|autogeek|carquest)\b/))
    return { txnClass: 'inventory', isExpense: true, isCashMovement: false, confidence: 'heuristic', evidence: 'name~parts supplier' }

  // 11) Fallback: an ordinary outflow expense.
  return { txnClass: 'expense', isExpense: true, isCashMovement: false, confidence: 'heuristic', evidence: pfcP ? `pfc:${pfcP}` : 'outflow' }
}

const toCents = (n: number) => Math.round(n * 100)

export interface IngestResult { items: number; accountsCovered: number; added: number; modified: number; removed: number; skippedIgnored: number; errors: string[] }

/** Pull + upsert + classify transactions for every active Item. Only accounts whose Plaid connector
 *  status is 'active' are ingested — ignored/closed accounts (e.g. AMB ····0169/····4183) are skipped. */
export async function ingestTransactions(actor: string | null): Promise<IngestResult> {
  const db = getDb()
  const items = await db.select().from(finPlaidItems).where(eq(finPlaidItems.status, 'active'))
  const res: IngestResult = { items: items.length, accountsCovered: 0, added: 0, modified: 0, removed: 0, skippedIgnored: 0, errors: [] }

  for (const it of items) {
    try {
      // Map this Item's Plaid accounts → status + mapped fin_account. Skip non-active.
      const pas = await db.select().from(finPlaidAccounts).where(eq(finPlaidAccounts.itemId, it.id))
      const byPlaidId = new Map(pas.map((p) => [p.plaidAccountId, p]))
      const activeIds = new Set(pas.filter((p) => p.status === 'active').map((p) => p.plaidAccountId))
      res.accountsCovered += activeIds.size

      let cursor = it.transactionsCursor ?? null
      let guard = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (++guard > 50) break // safety
        const page = await transactionsSync(decrypt(it.accessTokenEnc), cursor)
        for (const t of [...page.added, ...page.modified]) {
          if (!activeIds.has(t.account_id)) { res.skippedIgnored++; continue }
          const pa = byPlaidId.get(t.account_id)
          const cls = classifyTxn(t)
          const isMod = page.modified.includes(t)
          await db.insert(finTransactions).values({
            plaidItemId: it.id, plaidAccountRef: pa?.id ?? null, finAccountId: pa?.mappedAccountId ?? null,
            plaidTransactionId: t.transaction_id, plaidAccountId: t.account_id, pendingPlaidTransactionId: t.pending_transaction_id ?? null,
            amountCents: toCents(t.amount), direction: t.amount > 0 ? 'out' : 'in', isoCurrency: t.iso_currency_code ?? null,
            txnDate: (t.authorized_date || t.date), authorizedDate: t.authorized_date ?? null, pending: Boolean(t.pending),
            name: t.name ?? null, merchantName: t.merchant_name ?? null, paymentChannel: t.payment_channel ?? null,
            pfcPrimary: t.personal_finance_category?.primary ?? null, pfcDetailed: t.personal_finance_category?.detailed ?? null, pfcConfidence: t.personal_finance_category?.confidence_level ?? null,
            categoryLegacy: (t.category ?? null) as any, txnClass: cls.txnClass, isExpense: cls.isExpense, isCashMovement: cls.isCashMovement,
            classConfidence: cls.confidence, classEvidence: cls.evidence, removed: false, raw: t as any, asOf: new Date(),
          }).onConflictDoUpdate({
            target: finTransactions.plaidTransactionId,
            set: {
              amountCents: toCents(t.amount), direction: t.amount > 0 ? 'out' : 'in', pending: Boolean(t.pending),
              txnDate: (t.authorized_date || t.date), name: t.name ?? null, merchantName: t.merchant_name ?? null,
              pfcPrimary: t.personal_finance_category?.primary ?? null, pfcDetailed: t.personal_finance_category?.detailed ?? null,
              txnClass: cls.txnClass, isExpense: cls.isExpense, isCashMovement: cls.isCashMovement, classConfidence: cls.confidence, classEvidence: cls.evidence,
              removed: false, raw: t as any, updatedAt: new Date(),
            },
          })
          if (isMod) res.modified++; else res.added++
        }
        for (const r of page.removed) {
          await db.update(finTransactions).set({ removed: true, updatedAt: new Date() }).where(eq(finTransactions.plaidTransactionId, r.transaction_id))
          res.removed++
        }
        cursor = page.nextCursor
        if (!page.hasMore) break
      }
      await db.update(finPlaidItems).set({ transactionsCursor: cursor, transactionsSyncedAt: new Date(), updatedAt: new Date() }).where(eq(finPlaidItems.id, it.id))
    } catch (e) {
      const msg = `${it.institutionName}: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`
      res.errors.push(msg)
      await db.update(finPlaidItems).set({ status: 'error', lastError: msg, updatedAt: new Date() }).where(eq(finPlaidItems.id, it.id))
    }
  }
  await db.insert(finEvents).values({ actor, action: 'plaid_transactions_sync', entity: 'fin_transactions', source: 'plaid', after: res as any })
  return res
}

// ── Read models ──────────────────────────────────────────────────────────────
export async function getRecentTransactions(limit = 40) {
  return getDb().select().from(finTransactions).where(eq(finTransactions.removed, false)).orderBy(desc(finTransactions.txnDate), desc(finTransactions.createdAt)).limit(limit)
}

export interface ClassSummaryRow { txnClass: string; n: number; outCents: number; inCents: number }
export async function getClassificationSummary(sinceDays = 90): Promise<{ rows: ClassSummaryRow[]; since: string; total: number; pending: number }> {
  const db = getDb()
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10)
  const rows = await db.select({
    txnClass: finTransactions.txnClass,
    n: sql<number>`count(*)::int`,
    outCents: sql<number>`coalesce(sum(case when direction='out' then amount_cents else 0 end),0)::int`,
    inCents: sql<number>`coalesce(sum(case when direction='in' then -amount_cents else 0 end),0)::int`,
  }).from(finTransactions).where(and(eq(finTransactions.removed, false), gte(finTransactions.txnDate, since))).groupBy(finTransactions.txnClass)
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(finTransactions).where(eq(finTransactions.removed, false))
  const [{ pending }] = await db.select({ pending: sql<number>`count(*)::int` }).from(finTransactions).where(and(eq(finTransactions.removed, false), eq(finTransactions.pending, true)))
  return { rows: rows.sort((a, b) => b.n - a.n), since, total: Number(total), pending: Number(pending) }
}

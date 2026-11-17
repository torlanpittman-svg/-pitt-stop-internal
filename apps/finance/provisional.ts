/**
 * Provisional spending — "what have we spent that QuickBooks has not recorded yet?"
 *
 * QuickBooks stays the accounting record. But the books lag the bank (card purchases are categorised weeks
 * later), so a QuickBooks profit figure for a recent month is missing real spending. This module finds that
 * spending and counts every purchase ONCE:
 *
 *   - The BANK FEED is the base. Every posted purchase that left a connected account is one item.
 *   - A RECEIPT explains a bank purchase; it never adds to it. A receipt is added on its own only when the
 *     bank feed cannot show the purchase (cash, a disconnected account, or too recent to have posted).
 *   - A purchase stops being unreconciled when QuickBooks has it: a person confirmed the match, or QuickBooks
 *     shows the same MERCHANT on the same paying account for the same amount in the same few days ("likely").
 *     Account + amount + date WITHOUT a merchant, or with competing candidates, is only a "possible match": it
 *     stays in the total and is shown for review.
 *   - Transfers, payroll, card payments, owner draws and loan payments are never spending here; loan / financing
 *     / back-tax payments the bank files under ordinary expenses are taken out too and listed apart.
 *   - The result is UNRECONCILED SPENDING, not a loss: classification is incomplete (a paper check or a cash
 *     withdrawal says nothing about what it bought).
 *
 * Nothing here writes anything, confirms anything, or posts to QuickBooks. A "likely" pairing is used only to
 * avoid counting a purchase twice in this estimate; it is never stored as a match. Receipts whose bank payment
 * is unclear are NOT added (that could double count) — they are listed for a person to look at.
 */
import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { businessReceipts } from '@/apps/expenses/schema'
import { isCompleteStatus } from '@/apps/expenses/types'
import { finAccounts, finObligations, finPlaidAccounts, finPlaidItems, finQbPurchases, finReceiptMatches, finTransactions } from './schema'
import { hasVendorWord, vendorToken } from './cash-checks'
import { liveLinks } from './purchase-links'
import { namesOverlap, scorePair } from './purchase-match'
import { isPurchaseTxnClass } from './txn-class'

const DAY = 86_400_000
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
const dayDiff = (a: string, b: string) => Math.round((utc(a) - utc(b)) / DAY)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** A paying account as both receipts and feeds name it: '*2649', '*5600', 'amex', or null when unknown. */
export function accountRefOf(name: string | null | undefined): string | null {
  const n = name ?? ''
  if (/2649/.test(n)) return '*2649'
  if (/5600/.test(n)) return '*5600'
  if (/amex|american express/i.test(n)) return 'amex'
  return null
}

export interface PReceipt {
  id: string; vendor: string | null; date: string | null; totalCents: number | null
  accountRef: string | null; paymentMethod: string | null; entity: string
  invoiceNumber?: string | null; orderNumber?: string | null; description?: string | null
}
export interface PTxn {
  id: string; date: string; amountCents: number; name: string | null; merchantName: string | null
  txnClass: string | null; isExpense: boolean; pending: boolean; accountRef: string | null
}
export interface PQb { key: string; date: string | null; totalCents: number; payee: string | null; accountRef: string | null; paymentType: string | null; text?: string | null }
export interface PLinks {
  receiptTxn: Record<string, string>      // receipt id → bank txn id (a person confirmed)
  receiptNoBank: string[]                 // receipt ids a person marked "no bank match"
  receiptQb: Record<string, string>       // receipt id → QuickBooks key (confirmed)
  txnQb: Record<string, string>           // bank txn id → QuickBooks key (confirmed)
}
/** How far each account's bank feed reaches. A purchase after `through` cannot be seen yet. */
export interface FeedCoverage { accountRef: string; through: string | null; healthy: boolean }

/**
 * in_quickbooks        a person confirmed the match
 * likely_in_quickbooks QuickBooks shows the SAME MERCHANT, account, amount and dates — or, for a paper check
 *                      (the bank shows no payee), the one and only candidate on both sides. Not stored.
 * possible_match       QuickBooks has an entry for the same account, amount and dates, but the merchant cannot be
 *                      checked or several records compete. It STAYS in unreconciled spending, flagged for review.
 * not_in_quickbooks    nothing in QuickBooks could be this purchase
 */
export type QbState = 'in_quickbooks' | 'likely_in_quickbooks' | 'possible_match' | 'not_in_quickbooks'
export type BankState = 'bank_confirmed' | 'bank_likely' | 'bank_only' | 'not_visible_yet' | 'cash'
export interface SpendItem {
  key: string
  source: 'bank' | 'receipt'              // which record carries the amount
  label: string; date: string; amountCents: number
  accountRef: string | null
  txnId: string | null; receiptIds: string[]
  bank: BankState; quickbooks: QbState
  entity: string | null                   // from the receipt, when there is one
  note: string                            // plain English: why it is in this bucket
  notExpense: string | null               // set when this is money out that is not a business expense (and why)
}
export interface UnclearReceipt { receiptId: string; label: string; date: string | null; amountCents: number; reason: string }
export interface ProvisionalSpending {
  month: string
  items: SpendItem[]
  totalCents: number                       // every purchase once
  inQuickBooksCents: number                // a person confirmed it
  likelyInQuickBooksCents: number          // QuickBooks shows a matching entry (not confirmed)
  provisionalCents: number                 // UNRECONCILED spending: not matched to QuickBooks (includes possible matches)
  provisionalCount: number
  possibleMatchCents: number               // …of which QuickBooks has a possible, unverified match — review these
  possibleMatchCount: number
  excluded: SpendItem[]                    // money out that is NOT an expense (loan / financing / back-tax payments) — never in the totals
  excludedCents: number
  provisionalReceiptBackedCents: number    // …of which a receipt explains the purchase
  provisionalBankOnlyCents: number         // …of which only the bank shows it
  provisionalReceiptOnlyCents: number      // …of which only a receipt shows it (bank cannot see it yet)
  provisionalByEntity: Record<string, number>   // receipt-backed provisional, by business
  bankConfirmedCount: number; bankLikelyCount: number
  unclear: UnclearReceipt[]                // receipts NOT counted, because their bank payment is unclear
  unclearCents: number
}

/**
 * Money out that is not a business expense even though the bank does not class it as a transfer or loan payment.
 * Deliberately narrow: named patterns, plus vendors of the owner's own confirmed debt / tax-plan / card bills.
 * Anything not recognised stays in — the total is called UNRECONCILED spending precisely because of that.
 */
export function notExpenseReason(t: Pick<PTxn, 'name' | 'merchantName'>, vendorTokens: string[] = []): string | null {
  const n = `${t.merchantName ?? ''} ${t.name ?? ''}`.toLowerCase()
  if (/internal revenue|\birs\b|usataxpymt/.test(n)) return 'Tax payment to the IRS (the back-tax plan is paying down a debt, not a cost of this month)'
  if (/premium finance|\blending\b|\bloan\b|financing|qbc_pmts|floor ?plan/.test(n)) return 'Loan or financing payment (mostly repaying principal; the interest is not split out)'
  const hit = vendorTokens.find((v) => v.length >= 3 && hasVendorWord(n, v))
  return hit ? `Payment on a confirmed debt, tax-plan or card bill (${hit})` : null
}

const inMonth = (d: string | null, month: string) => !!d && d.slice(0, 7) === month
const QB_NOTE: Record<QbState, string> = {
  in_quickbooks: 'In QuickBooks (confirmed).',
  likely_in_quickbooks: 'QuickBooks shows this purchase (same merchant, account, amount and dates) — not yet confirmed.',
  possible_match: 'QuickBooks has an entry for the same account, amount and dates, but the merchant can’t be checked or more than one record fits — still counted as unreconciled until someone reviews it.',
  not_in_quickbooks: 'Not in QuickBooks yet.',
}
const txnLabel = (t: PTxn) => t.merchantName || t.name || 'Bank payment'

/** Greedy one-to-one assignment: cheapest pairs first; each side is used at most once. */
function assign<A, B>(pairs: { a: A; b: B; cost: number }[], aKey: (a: A) => string, bKey: (b: B) => string, takenA = new Set<string>(), takenB = new Set<string>()): Map<string, B> {
  const out = new Map<string, B>()
  for (const p of pairs.slice().sort((x, y) => x.cost - y.cost)) {
    const ak = aKey(p.a), bk = bKey(p.b)
    if (takenA.has(ak) || takenB.has(bk)) continue
    takenA.add(ak); takenB.add(bk); out.set(ak, p.b)
  }
  return out
}

/** QuickBooks ↔ bank date window: a written check clears up to ~60 days later; a bank-feed entry is the same day. */
function qbDateFits(bankOrReceiptDate: string, qb: PQb): number | null {
  if (!isDate(qb.date)) return null
  const delta = dayDiff(bankOrReceiptDate, qb.date)          // + = QuickBooks entry is earlier
  if ((qb.paymentType ?? '').toLowerCase() === 'check') return delta >= -2 && delta <= 60 ? Math.abs(delta) / 10 : null
  return Math.abs(delta) <= 5 ? Math.abs(delta) : null
}

/**
 * PURE. `txns` should reach ~70 days before the month so one-to-one pairing with QuickBooks is fair to earlier
 * payments; only purchases DATED IN `month` are reported.
 */
export function computeProvisional(input: { month: string; receipts: PReceipt[]; txns: PTxn[]; qb: PQb[]; links: PLinks; feeds: FeedCoverage[]; notExpenseVendors?: string[] }): ProvisionalSpending {
  const { month, links } = input
  const posted = input.txns.filter((t) => !t.pending)
  const txnById = new Map(posted.map((t) => [t.id, t]))
  const isPurchase = (t: PTxn) => t.isExpense && isPurchaseTxnClass(t.txnClass)
  const receipts = input.receipts.filter((r) => (r.totalCents ?? 0) > 0)

  // ── 1. bank ↔ QuickBooks: confirmed first, then one-to-one on account + exact amount + date ──
  const qbByKey = new Map(input.qb.map((q) => [q.key, q]))
  const confirmedQbForTxn = new Map(Object.entries(links.txnQb).filter(([t, q]) => txnById.has(t) && qbByKey.has(q)))
  const takenTxn = new Set(confirmedQbForTxn.keys()), takenQb = new Set(confirmedQbForTxn.values())
  for (const q of Object.values(links.receiptQb)) takenQb.add(q)
  // Merchant-verified first: the QuickBooks payee/description names the same merchant as the bank line.
  const isCheckPair = (t: PTxn, q: PQb) => t.txnClass === 'check' || (q.paymentType ?? '').toLowerCase() === 'check'
  const named: { a: PTxn; b: PQb; cost: number }[] = [], unnamed: { a: PTxn; b: PQb; cost: number }[] = []
  for (const t of posted) for (const q of input.qb) {
    if (q.totalCents !== t.amountCents || !t.accountRef || q.accountRef !== t.accountRef) continue
    const fit = qbDateFits(t.date, q); if (fit == null) continue
    ;(namesOverlap([q.payee, q.text], [t.merchantName, t.name]) ? named : unnamed).push({ a: t, b: q, cost: fit })
  }
  const likelyQbForTxn = assign(named, (t) => t.id, (q) => q.key, takenTxn, takenQb)
  // No merchant to compare (a paper check clears as "Check(…)"; some entries carry no payee): account + amount +
  // date is NOT enough on its own. Only a pairing that is the single candidate on BOTH sides is accepted; anything
  // with a competing candidate is a POSSIBLE match — it stays in unreconciled spending and is shown for review.
  const open2 = unnamed.filter((p) => !takenTxn.has(p.a.id) && !takenQb.has(p.b.key))
  const perTxn = new Map<string, number>(), perQb = new Map<string, number>()
  for (const p of open2) { perTxn.set(p.a.id, (perTxn.get(p.a.id) ?? 0) + 1); perQb.set(p.b.key, (perQb.get(p.b.key) ?? 0) + 1) }
  const possibleQbForTxn = new Set<string>()
  for (const p of open2) {
    if (isCheckPair(p.a, p.b) && perTxn.get(p.a.id) === 1 && perQb.get(p.b.key) === 1) { likelyQbForTxn.set(p.a.id, p.b); takenTxn.add(p.a.id); takenQb.add(p.b.key) }
    else possibleQbForTxn.add(p.a.id)
  }

  // ── 2. receipt ↔ bank: confirmed first, then one-to-one on exact amount + ≤5 days + same vendor + same account ──
  const receiptTxn = new Map<string, { txn: PTxn; confirmed: boolean }>()
  const claimedTxn = new Set<string>()
  for (const r of receipts) {
    const t = txnById.get(links.receiptTxn[r.id] ?? '')
    if (t) { receiptTxn.set(r.id, { txn: t, confirmed: true }); claimedTxn.add(t.id) }
  }
  const noBank = new Set(links.receiptNoBank)
  const open = receipts.filter((r) => !receiptTxn.has(r.id) && !noBank.has(r.id) && isDate(r.date))
  const accountOk = (r: PReceipt, t: PTxn) => !r.accountRef || !t.accountRef || !/^(\*\d{4}|amex)$/.test(r.accountRef) || r.accountRef === t.accountRef
  const rtPairs: { a: PReceipt; b: PTxn; cost: number }[] = []
  const weak = new Set<string>()             // receipts with only an unproven candidate (amount alone, or near amount)
  for (const r of open) for (const t of posted) {
    if (!isPurchase(t) || claimedTxn.has(t.id) || !accountOk(r, t)) continue
    const s = scorePair({ amountCents: r.totalCents, date: r.date, names: [r.vendor], refs: [r.invoiceNumber, r.orderNumber], text: [r.description] }, { amountCents: t.amountCents, date: t.date, names: [t.merchantName, t.name], text: [t.name] }, { maxDays: 5 })
    if (s.strength === 'strong') rtPairs.push({ a: r, b: t, cost: s.dateDeltaDays ?? 9 })
    else if (s.strength === 'possible') weak.add(r.id)
  }
  const likelyTxnForReceipt = assign(rtPairs, (r) => r.id, (t) => t.id, new Set(), new Set(claimedTxn))
  for (const [rid, t] of likelyTxnForReceipt) receiptTxn.set(rid, { txn: t, confirmed: false })

  const receiptsByTxn = new Map<string, { r: PReceipt; confirmed: boolean }[]>()
  for (const r of receipts) { const m = receiptTxn.get(r.id); if (m) (receiptsByTxn.get(m.txn.id) ?? receiptsByTxn.set(m.txn.id, []).get(m.txn.id)!).push({ r, confirmed: m.confirmed }) }

  // ── 3. items: every bank purchase in the month, each carrying its receipt(s) ──
  const items: SpendItem[] = []
  for (const t of posted) {
    if (!inMonth(t.date, month) || !isPurchase(t)) continue
    const rs = receiptsByTxn.get(t.id) ?? []
    const receiptQbConfirmed = rs.some((x) => links.receiptQb[x.r.id] && qbByKey.has(links.receiptQb[x.r.id]))
    const quickbooks: QbState = confirmedQbForTxn.has(t.id) || receiptQbConfirmed ? 'in_quickbooks' : likelyQbForTxn.has(t.id) ? 'likely_in_quickbooks' : possibleQbForTxn.has(t.id) ? 'possible_match' : 'not_in_quickbooks'
    const bank: BankState = rs.length === 0 ? 'bank_only' : rs.some((x) => x.confirmed) ? 'bank_confirmed' : 'bank_likely'
    items.push({
      key: `bank:${t.id}`, source: 'bank', label: rs[0]?.r.vendor || txnLabel(t), date: t.date, amountCents: t.amountCents, accountRef: t.accountRef,
      txnId: t.id, receiptIds: rs.map((x) => x.r.id), bank, quickbooks, entity: rs[0]?.r.entity ?? null,
      note: [
        bank === 'bank_only' ? 'Seen at the bank; no receipt filed.' : bank === 'bank_confirmed' ? 'Receipt matched to the bank payment (confirmed).' : 'Receipt and bank payment look like the same purchase (same amount, vendor and dates) — not yet confirmed.',
        QB_NOTE[quickbooks],
      ].join(' '),
      notExpense: notExpenseReason(t, input.notExpenseVendors),
    })
  }

  // ── 4. receipts the bank cannot show ──
  const feed = new Map(input.feeds.map((f) => [f.accountRef, f]))
  const unclear: UnclearReceipt[] = []
  const rqPairs: { a: PReceipt; b: PQb; cost: number }[] = []
  const receiptOnly: { r: PReceipt; bank: BankState; why: string }[] = []
  for (const r of receipts) {
    if (!inMonth(r.date, month) || receiptTxn.has(r.id)) continue
    const label = r.vendor || 'Receipt', amountCents: number = r.totalCents as number
    const cash = r.paymentMethod === 'cash' || r.accountRef === 'cash'
    const f = r.accountRef ? feed.get(r.accountRef) : undefined
    if (cash || noBank.has(r.id)) { receiptOnly.push({ r, bank: 'cash', why: cash ? 'Paid in cash — the bank never shows it.' : 'Marked “no bank match” by a person.' }); continue }
    if (!f || !f.through) { receiptOnly.push({ r, bank: 'not_visible_yet', why: `No bank feed is connected for ${r.accountRef ?? 'this payment source'}.` }); continue }
    if (dayDiff(r.date as string, f.through) > -2) { receiptOnly.push({ r, bank: 'not_visible_yet', why: `The ${r.accountRef} bank feed only reaches ${f.through}${f.healthy ? '' : ' (that connection is not updating)'} — this purchase is not visible there yet.` }); continue }
    unclear.push({ receiptId: r.id, label, date: r.date, amountCents, reason: weak.has(r.id)
      ? `A ${r.accountRef} bank payment has a similar amount but the vendor or amount does not line up — confirm the match.`
      : `Paid from ${r.accountRef}, but no bank payment for this amount was found within 5 days. Check the receipt’s date, total and payment source.` })
  }
  const possibleQbForReceipt = new Set<string>()
  for (const { r } of receiptOnly) for (const q of input.qb) {
    if (takenQb.has(q.key) || q.totalCents !== r.totalCents) continue
    const fit = qbDateFits(r.date as string, q); if (fit == null) continue
    if (namesOverlap([q.payee, q.text], [r.vendor])) rqPairs.push({ a: r, b: q, cost: fit })
    else if (r.accountRef && q.accountRef === r.accountRef) possibleQbForReceipt.add(r.id)       // same account, merchant unverified
  }
  const likelyQbForReceipt = assign(rqPairs, (r) => r.id, (q) => q.key, new Set(), takenQb)
  for (const { r, bank, why } of receiptOnly) {
    const quickbooks: QbState = links.receiptQb[r.id] && qbByKey.has(links.receiptQb[r.id]) ? 'in_quickbooks' : likelyQbForReceipt.has(r.id) ? 'likely_in_quickbooks' : possibleQbForReceipt.has(r.id) ? 'possible_match' : 'not_in_quickbooks'
    items.push({
      key: `receipt:${r.id}`, source: 'receipt', label: r.vendor || 'Receipt', date: r.date as string, amountCents: r.totalCents as number, accountRef: r.accountRef,
      txnId: null, receiptIds: [r.id], bank, quickbooks, entity: r.entity,
      note: `${why} ${QB_NOTE[quickbooks]}`, notExpense: null,
    })
  }

  items.sort((a, b) => b.date.localeCompare(a.date) || b.amountCents - a.amountCents)
  const sum = (xs: SpendItem[]) => xs.reduce((s, x) => s + x.amountCents, 0)
  // Money out that is not an expense never enters any total; it is listed apart so nothing disappears.
  const excluded = items.filter((i) => i.notExpense), spend = items.filter((i) => !i.notExpense)
  const prov = spend.filter((i) => i.quickbooks === 'not_in_quickbooks' || i.quickbooks === 'possible_match')
  const possible = prov.filter((i) => i.quickbooks === 'possible_match')
  const provisionalByEntity: Record<string, number> = {}
  for (const i of prov) if (i.receiptIds.length && i.entity) provisionalByEntity[i.entity] = (provisionalByEntity[i.entity] ?? 0) + i.amountCents
  return {
    month, items: spend, totalCents: sum(spend),
    inQuickBooksCents: sum(spend.filter((i) => i.quickbooks === 'in_quickbooks')),
    likelyInQuickBooksCents: sum(spend.filter((i) => i.quickbooks === 'likely_in_quickbooks')),
    provisionalCents: sum(prov), provisionalCount: prov.length,
    possibleMatchCents: sum(possible), possibleMatchCount: possible.length,
    excluded, excludedCents: sum(excluded),
    provisionalReceiptBackedCents: sum(prov.filter((i) => i.source === 'bank' && i.receiptIds.length > 0)),
    provisionalBankOnlyCents: sum(prov.filter((i) => i.bank === 'bank_only')),
    provisionalReceiptOnlyCents: sum(prov.filter((i) => i.source === 'receipt')),
    provisionalByEntity,
    bankConfirmedCount: spend.filter((i) => i.bank === 'bank_confirmed').length,
    bankLikelyCount: spend.filter((i) => i.bank === 'bank_likely').length,
    unclear, unclearCents: unclear.reduce((s, u) => s + u.amountCents, 0),
  }
}

/** Trace one receipt through the model (used by the acceptance check and the detail list). */
export function traceReceipt(p: ProvisionalSpending, receiptId: string): { item: SpendItem | null; unclear: UnclearReceipt | null } {
  return { item: p.items.find((i) => i.receiptIds.includes(receiptId)) ?? null, unclear: p.unclear.find((u) => u.receiptId === receiptId) ?? null }
}

export interface ProvisionalView extends ProvisionalSpending {
  feeds: FeedCoverage[]
  quickBooksThrough: { cardAndAch: string | null; checks: string | null }   // newest QuickBooks entry on the operating account
}

/** DB loader. `month` is 'YYYY-MM'. Read-only. */
export async function getProvisionalSpending(month: string): Promise<ProvisionalView> {
  const db = getDb()
  const start = `${month}-01`
  const end = iso(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0))
  const wide = iso(utc(start) - 70 * DAY), near = iso(utc(start) - 7 * DAY), after = iso(utc(end) + 12 * DAY)
  const [rRows, tRows, qRows, links, matches, accts, plaidAccts, items, bills] = await Promise.all([
    db.select().from(businessReceipts).where(and(ne(businessReceipts.status, 'rejected'), gte(businessReceipts.receiptDate, near), lte(businessReceipts.receiptDate, end))),
    db.select().from(finTransactions).where(and(eq(finTransactions.direction, 'out'), eq(finTransactions.removed, false), gte(finTransactions.txnDate, wide), lte(finTransactions.txnDate, after))),
    db.select().from(finQbPurchases).where(and(gte(finQbPurchases.txnDate, wide), lte(finQbPurchases.txnDate, after))),
    liveLinks(['receipt_qb', 'txn_qb']),
    db.select().from(finReceiptMatches),
    db.select().from(finAccounts),
    db.select().from(finPlaidAccounts).where(inArray(finPlaidAccounts.status, ['active'])),
    db.select().from(finPlaidItems),
    db.select({ vendor: finObligations.vendor, category: finObligations.category }).from(finObligations).where(eq(finObligations.status, 'confirmed')),
  ])
  const notExpenseVendors = bills.filter((b) => ['debt', 'tax', 'card_payment', 'owner_draw'].includes(b.category ?? '')).map((b) => vendorToken(b.vendor)).filter((v): v is string => !!v)
  const acctName = new Map(accts.map((a) => [a.id, a.name]))
  const refOfTxn = (t: (typeof tRows)[number]) => accountRefOf(t.finAccountId ? acctName.get(t.finAccountId) : null)
  const receipts: PReceipt[] = rRows.filter((r) => isCompleteStatus(r.status) && r.funding !== 'personal' && r.funding !== 'unpaid').map((r) => ({
    id: r.id, vendor: r.vendor, date: r.receiptDate, totalCents: r.totalCents, accountRef: r.accountRef, paymentMethod: r.paymentMethod, entity: r.entity,
    invoiceNumber: r.invoiceNumber, orderNumber: r.orderNumber, description: r.description,
  }))
  const txns: PTxn[] = tRows.map((t) => ({ id: t.id, date: t.txnDate, amountCents: t.amountCents, name: t.name, merchantName: t.merchantName, txnClass: t.txnClass, isExpense: t.isExpense, pending: t.pending, accountRef: refOfTxn(t) }))
  const qbLive = qRows.filter((q) => !q.missingSince)
  const qb: PQb[] = qbLive.map((q) => ({ key: q.qbKey, date: q.txnDate, totalCents: q.totalCents, payee: q.payeeName, accountRef: accountRefOf(q.accountName), paymentType: q.paymentType, text: [q.lineSummary, q.privateNote].filter(Boolean).join(' ') }))
  const confirmed = links.filter((l) => l.status === 'confirmed')
  const pl: PLinks = {
    receiptTxn: Object.fromEntries(matches.filter((m) => m.status === 'confirmed' && m.txnId).map((m) => [m.receiptId, m.txnId as string])),
    receiptNoBank: matches.filter((m) => m.status === 'dismissed').map((m) => m.receiptId),
    receiptQb: Object.fromEntries(confirmed.filter((l) => l.kind === 'receipt_qb').map((l) => [l.aId, l.bId])),
    txnQb: Object.fromEntries(confirmed.filter((l) => l.kind === 'txn_qb').map((l) => [l.aId, l.bId])),
  }
  // Feed reach per account: newest posted transaction, and whether that bank connection is healthy.
  const itemStatus = new Map(items.map((i) => [i.id, i.status]))
  const feeds: FeedCoverage[] = []
  for (const pa of plaidAccts) {
    if (!pa.mappingVerified || !pa.mappedAccountId) continue
    const ref = accountRefOf(acctName.get(pa.mappedAccountId)); if (!ref) continue
    const through = txns.filter((t) => t.accountRef === ref && !t.pending).reduce<string | null>((m, t) => (!m || t.date > m ? t.date : m), null)
    feeds.push({ accountRef: ref, through, healthy: itemStatus.get(pa.itemId) === 'active' })
  }
  const opQb = qbLive.filter((q) => accountRefOf(q.accountName) === '*2649' && q.txnDate && !/quickbooks payments/i.test(q.payeeName ?? ''))
  const newest = (xs: typeof opQb) => xs.reduce<string | null>((m, q) => (!m || (q.txnDate as string) > m ? q.txnDate : m), null)
  return {
    ...computeProvisional({ month, receipts, txns, qb, links: pl, feeds, notExpenseVendors }), feeds,
    quickBooksThrough: { cardAndAch: newest(opQb.filter((q) => (q.paymentType ?? '') !== 'Check')), checks: newest(opQb.filter((q) => q.paymentType === 'Check')) },
  }
}

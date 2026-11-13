/**
 * Owner reconciliation model — everything the /admin/finance/reconcile page shows beyond the review queues:
 *   - suggested matches between sources (never auto-linked; ambiguous ones are marked for review),
 *   - the matches a person has confirmed (persisted — not re-guessed on load),
 *   - expected bills against their actual payments (a payment IS its bill; forecast and actual are never added),
 *   - purchases "counted once" across receipts, bank/card, checks, QuickBooks and the inventory-vehicle ledger,
 *   - cash movements that are NOT purchases (card payments, transfers, payroll, loan payments, owner draws),
 *   - how complete each source is.
 * READ-ONLY. The only writes live in purchase-links.ts / receipts-cfo.ts and happen when a person clicks.
 */
import { and, eq, gte, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { businessReceipts } from '@/apps/expenses/schema'
import { isCompleteStatus } from '@/apps/expenses/types'
import { receiptPaymentLabel } from '@/apps/expenses/payment'
import { vehicleFinancialEvents } from '@/apps/auto-sales/schema'
import { costRelevance, type EconomicCategory } from '@/apps/auto-sales/types'
import { checks } from '@/apps/checks/schema'
import { finObligations, finQbPurchases, finReceiptMatches, finSyncRuns, finTransactions } from './schema'
import { isPurchaseTxnClass } from './txn-class'
import { liveLinks, LINK_KINDS, type LinkKind, type LinkRow } from './purchase-links'
import { rankMatches, type MatchSide, type MatchScore } from './purchase-match'
import { countOnce, nodeKey, type CountedOnce, type PurchaseEdge, type PurchaseNode } from './purchase-ledger'
import { desc } from 'drizzle-orm'

const DAY = 86_400_000
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`)

export interface RecordView { type: string; id: string; title: string; detail: string; amountCents: number | null; date: string | null }
export interface Suggestion { kind: LinkKind; kindLabel: string; a: RecordView; b: RecordView; strength: 'strong' | 'possible'; ambiguous: boolean; reasons: string[]; evidence: MatchScore }
export interface ConfirmedMatch { linkId: string | null; kind: LinkKind | 'receipt_txn'; kindLabel: string; a: RecordView; b: RecordView; decidedBy: string | null; decidedAt: string | null }
export type BillState = 'paid_confirmed' | 'payment_suggested' | 'not_seen' | 'not_observable' | 'cannot_check'
export interface BillRow {
  obligationId: string; vendor: string; frequency: string | null; expectedCents: number | null
  state: BillState; explain: string
  payment: RecordView | null        // the confirmed (or suggested) actual payment
  linkId: string | null
}
export interface CashMovement { txnClass: string; label: string; count: number; cents: number }
export interface SourceCoverage { key: string; label: string; state: 'ok' | 'stale' | 'partial' | 'unavailable'; detail: string }
export interface OwnerReconciliation {
  today: string; windowStart: string; days: number
  suggestions: Suggestion[]; suggestionsTotal: number
  confirmed: ConfirmedMatch[]
  bills: BillRow[]; billsExpectedCents: number; billsPaidConfirmedCents: number
  ledger: CountedOnce
  cashMovements: CashMovement[]
  coverage: SourceCoverage[]
}

const PERIOD: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 31, quarterly: 92, annual: 366, yearly: 366 }
const CLASS_LABEL: Record<string, string> = {
  card_payment: 'Credit-card payments (the purchases were already counted on the card)',
  transfer: 'Transfers between accounts', payroll: 'Payroll', debt_payment: 'Loan / floor-plan payments (principal and interest are not split here)',
  owner_draw: 'Owner draws / distributions',
  people_checks: 'Checks written to employees or the owner (payroll, draws or reimbursements — review any that were really a purchase)',
}
const SUGGESTION_LIMIT = 40

export async function getOwnerReconciliation(opts: { today: string; days?: number }): Promise<OwnerReconciliation> {
  const db = getDb()
  const days = opts.days ?? 60
  const today = opts.today
  const windowStart = iso(utc(today) - days * DAY)
  const wideStart = iso(utc(windowStart) - 45 * DAY) // partners may sit a little outside the window

  const [receiptsAll, txnsAll, checksAll, qbAll, eventsAll, obligations, links, receiptMatches, lastQbo] = await Promise.all([
    db.select().from(businessReceipts).where(and(ne(businessReceipts.status, 'rejected'), gte(businessReceipts.createdAt, new Date(utc(wideStart))))),
    db.select().from(finTransactions).where(and(eq(finTransactions.direction, 'out'), eq(finTransactions.removed, false), gte(finTransactions.txnDate, wideStart))),
    db.select().from(checks).where(and(ne(checks.qbStatus, 'voided'), gte(checks.checkDate, wideStart))),
    db.select().from(finQbPurchases).where(gte(finQbPurchases.txnDate, wideStart)),
    db.select().from(vehicleFinancialEvents).where(and(ne(vehicleFinancialEvents.status, 'void'), gte(vehicleFinancialEvents.eventDate, wideStart))),
    db.select().from(finObligations).where(eq(finObligations.status, 'confirmed')),
    liveLinks(),
    db.select().from(finReceiptMatches).where(eq(finReceiptMatches.status, 'confirmed')),
    db.select({ at: finSyncRuns.finishedAt, summary: finSyncRuns.summary }).from(finSyncRuns).where(and(eq(finSyncRuns.source, 'qbo'), eq(finSyncRuns.status, 'ok'))).orderBy(desc(finSyncRuns.startedAt)).limit(1),
  ])
  const receipts = receiptsAll.filter((r) => isCompleteStatus(r.status))
  const txns = txnsAll.filter((t) => !t.pending)
  const qb = qbAll.filter((q) => !q.missingSince)
  const reversed = new Set(eventsAll.map((e) => e.reversesEventId).filter(Boolean) as string[])
  const events = eventsAll.filter((e) => !e.reversesEventId && !reversed.has(e.id) && costRelevance(e.economicCategory as EconomicCategory) === 'cost_add')
  // A check (or QuickBooks entry) paid to an EMPLOYEE, or categorised as the owner's personal money, is payroll,
  // a draw or a reimbursement — a cash movement, not a vendor purchase. It is listed apart, never counted as one.
  const isPeopleCheck = (c: (typeof checksAll)[number]) => c.payeeQboEntityType === 'Employee' || c.category === 'owner_personal'
  const peopleQbKeys = new Set([
    ...checksAll.filter((c) => isPeopleCheck(c) && c.qboTxnId).map((c) => `Purchase:${c.qboTxnId}`),
    ...qbAll.filter((q) => q.payeeType === 'Employee').map((q) => q.qbKey),
  ])
  const bankThrough = txnsAll.length ? txnsAll.reduce((m, t) => (t.txnDate > m ? t.txnDate : m), '0000-00-00') : null

  // ---- record views ----
  const view = {
    receipt: (r: (typeof receipts)[number]): RecordView => ({ type: 'receipt', id: r.id, title: [r.vendor || 'Receipt', r.description].filter(Boolean).join(' — '), detail: [receiptPaymentLabel(r), r.invoiceNumber && `invoice ${r.invoiceNumber}`, r.orderNumber && `order ${r.orderNumber}`].filter(Boolean).join(' · '), amountCents: r.totalCents, date: r.receiptDate }),
    txn: (t: (typeof txns)[number]): RecordView => ({ type: 'bank_txn', id: t.id, title: t.merchantName || t.name || 'Bank payment', detail: `bank · ${t.txnClass ?? 'unclassified'}`, amountCents: t.amountCents, date: t.txnDate }),
    check: (c: (typeof checksAll)[number]): RecordView => ({ type: 'check', id: c.id, title: `Check #${c.checkNumber} — ${c.payeeName}`, detail: [c.memo, c.qbStatus === 'recorded' ? 'recorded in QuickBooks' : `QuickBooks: ${c.qbStatus}`].filter(Boolean).join(' · '), amountCents: c.amountCents, date: c.checkDate }),
    qb: (q: (typeof qb)[number]): RecordView => ({ type: 'qb_purchase', id: q.qbKey, title: `QuickBooks ${q.qbType === 'Bill' ? 'bill' : (q.paymentType ?? 'expense').toLowerCase()} — ${q.payeeName ?? 'no payee'}`, detail: [q.docNumber && `#${q.docNumber}`, q.accountName, q.expenseAccounts, q.privateNote].filter(Boolean).join(' · '), amountCents: q.totalCents, date: q.txnDate }),
    event: (e: (typeof events)[number]): RecordView => ({ type: 'vehicle_event', id: e.id, title: `Vehicle cost — ${e.vendor ?? e.economicCategory}`, detail: [e.economicCategory, e.memo].filter(Boolean).join(' · '), amountCents: e.amountCents, date: e.eventDate }),
  }
  const side = {
    receipt: (r: (typeof receipts)[number]): MatchSide => ({ amountCents: r.totalCents, date: r.receiptDate, names: [r.vendor], refs: [r.invoiceNumber, r.orderNumber], text: [r.memo, r.description] }),
    txn: (t: (typeof txns)[number]): MatchSide => ({ amountCents: t.amountCents, date: t.txnDate, names: [t.merchantName, t.name], text: [t.name] }),
    check: (c: (typeof checksAll)[number]): MatchSide => ({ amountCents: c.amountCents, date: c.checkDate, names: [c.payeeName], refs: [String(c.checkNumber)], text: [c.memo] }),
    qb: (q: (typeof qb)[number]): MatchSide => ({ amountCents: q.totalCents, date: q.txnDate, names: [q.payeeName, q.lineSummary], refs: [q.docNumber], text: [q.privateNote, q.lineSummary] }),
    event: (e: (typeof events)[number]): MatchSide => ({ amountCents: e.amountCents, date: e.eventDate, names: [e.vendor], text: [e.memo] }),
  }

  // ---- decisions already made ----
  const decided = new Set(links.map((l) => `${l.kind}|${l.aId}|${l.bId}`))
  const confirmedLinks = links.filter((l) => l.status === 'confirmed')
  const takenA = (k: LinkKind) => new Set(confirmedLinks.filter((l) => l.kind === k).map((l) => l.aId))
  const takenB = (k: LinkKind) => new Set(confirmedLinks.filter((l) => l.kind === k).map((l) => l.bId))
  const inWindow = (d: string | null) => !!d && d >= windowStart

  // ---- suggestions (one best partner per record; ambiguous ties are flagged, never chosen) ----
  const suggestions: Suggestion[] = []
  function suggest<A, B>(kind: LinkKind, as: A[], bs: B[], aSide: (a: A) => MatchSide, bSide: (b: B) => MatchSide, aView: (a: A) => RecordView, bView: (b: B) => RecordView, opts: { maxDays?: number; pair?: (a: A, b: B) => boolean; strongOnly?: boolean } = {}) {
    const ta = takenA(kind), tb = takenB(kind)
    for (const a of as) {
      const av = aView(a)
      if (kind !== 'bill_payment' && ta.has(av.id)) continue
      const pool = bs.filter((b) => { const bv = bView(b); return !tb.has(bv.id) && !decided.has(`${kind}|${av.id}|${bv.id}`) && (!opts.pair || opts.pair(a, b)) })
      const best = rankMatches(aSide(a), pool, bSide, { maxDays: opts.maxDays, limit: 1 })[0]
      if (!best || (opts.strongOnly && best.score.strength !== 'strong')) continue
      suggestions.push({ kind, kindLabel: LINK_KINDS[kind].label, a: av, b: bView(best.item), strength: best.score.strength as 'strong' | 'possible', ambiguous: best.ambiguous, reasons: best.score.reasons, evidence: best.score })
    }
  }
  const winReceipts = receipts.filter((r) => inWindow(r.receiptDate) || (!r.receiptDate && r.createdAt.getTime() >= utc(windowStart)))
  const winChecks = checksAll.filter((c) => inWindow(c.checkDate))
  // A check the app wrote already IS a QuickBooks entry (qbo_txn_id) — that identity needs no suggestion.
  const checkQbKeys = new Set(checksAll.map((c) => (c.qboTxnId ? `Purchase:${c.qboTxnId}` : '')).filter(Boolean))
  const qbPurchasesOnly = qb.filter((q) => !peopleQbKeys.has(q.qbKey))
  suggest('receipt_qb', winReceipts, qbPurchasesOnly, side.receipt, side.qb, view.receipt, view.qb)
  suggest('receipt_vehicle_event', winReceipts.filter((r) => r.inventoryVehicleId), events, side.receipt, side.event, view.receipt, view.event, { pair: (r, e) => r.inventoryVehicleId === e.inventoryVehicleId, maxDays: 7 })
  suggest('check_txn', winChecks, txns.filter((t) => t.txnClass === 'check' || t.txnClass === 'payroll' || /check/i.test(t.name ?? '')), side.check, side.txn, view.check, view.txn, { maxDays: 60 })
  suggest('check_receipt', winChecks, receipts.filter((r) => r.paymentMethod === 'check'), side.check, side.receipt, view.check, view.receipt, { maxDays: 14 })
  suggest('txn_qb', txns.filter((t) => inWindow(t.txnDate) && t.isExpense && isPurchaseTxnClass(t.txnClass)), qbPurchasesOnly.filter((q) => q.qbType === 'Purchase' && !checkQbKeys.has(q.qbKey)), side.txn, side.qb, view.txn, view.qb, { strongOnly: true })

  // ---- expected bills ↔ actual payments (persisted) ----
  const txnById = new Map(txnsAll.map((t) => [t.id, t]))
  const bills: BillRow[] = []
  const billPaidTxn = takenB('bill_payment')
  for (const ob of obligations) {
    const expected = ob.amountCents ?? ob.avgAmountCents
    const period = PERIOD[(ob.frequency ?? '').toLowerCase()]
    const base = { obligationId: ob.id, vendor: ob.vendor, frequency: ob.frequency, expectedCents: expected }
    if (!period) { bills.push({ ...base, state: 'cannot_check', explain: ob.frequency ? `A “${ob.frequency}” bill has no fixed period to check.` : 'No frequency is set for this bill.', payment: null, linkId: null }); continue }
    const since = iso(utc(today) - (period + 5) * DAY)
    const mine = confirmedLinks.filter((l) => l.kind === 'bill_payment' && l.aId === ob.id)
      .map((l) => ({ l, t: txnById.get(l.bId) })).filter((x) => x.t && x.t.txnDate >= since).sort((x, y) => (y.t!.txnDate).localeCompare(x.t!.txnDate))[0]
    if (mine?.t) { bills.push({ ...base, state: 'paid_confirmed', explain: `Paid — the ${mine.t.txnDate} bank payment is this bill. It is counted once, as the actual payment.`, payment: view.txn(mine.t as (typeof txns)[number]), linkId: mine.l.id }); continue }
    const lo = ob.amountMinCents ?? (expected != null ? Math.round(expected * 0.85) : null), hi = ob.amountMaxCents ?? (expected != null ? Math.round(expected * 1.15) : null)
    const cat = (ob.category ?? '').toLowerCase()
    const pool = txns.filter((t) => t.txnDate >= since && t.txnDate <= today && !billPaidTxn.has(t.id) && !decided.has(`bill_payment|${ob.id}|${t.id}`)
      && (lo == null || hi == null || (t.amountCents >= lo && t.amountCents <= hi))
      && ((/payroll/.test(cat) && t.txnClass === 'payroll') || (/debt|loan|floor/.test(cat) && t.txnClass === 'debt_payment') || rankMatches({ amountCents: t.amountCents, date: t.txnDate, names: [ob.vendor, ob.discoveryKey] }, [t], side.txn, { maxDays: 400 }).some((m) => m.score.nameOverlap)))
      .sort((a, b) => b.txnDate.localeCompare(a.txnDate))
    if (pool[0]) { bills.push({ ...base, state: 'payment_suggested', explain: pool.length > 1 ? `${pool.length} payments could be this bill — confirm the right one.` : 'A payment that looks like this bill has posted — confirm it.', payment: view.txn(pool[0]), linkId: null }); continue }
    const feedBehind = !bankThrough || Math.round((utc(today) - utc(bankThrough)) / DAY) > 3
    bills.push({ ...base, state: feedBehind ? 'not_observable' : 'not_seen', payment: null, linkId: null,
      explain: feedBehind ? `The bank feed only runs through ${bankThrough ?? 'no date'}, so a recent payment cannot be seen yet.` : `No matching payment in the last ${period + 5} days of bank activity. It may be paid from another account, named differently by the bank, or unpaid.` })
  }

  // ---- confirmed matches (persisted) ----
  const byId = {
    receipt: new Map(receiptsAll.map((r) => [r.id, r])), check: new Map(checksAll.map((c) => [c.id, c])),
    qb: new Map(qbAll.map((q) => [q.qbKey, q])), event: new Map(eventsAll.map((e) => [e.id, e])),
  }
  const viewOf = (type: string, id: string): RecordView => {
    const r = type === 'receipt' ? byId.receipt.get(id) : null, t = type === 'bank_txn' ? txnById.get(id) : null
    const c = type === 'check' ? byId.check.get(id) : null, q = type === 'qb_purchase' ? byId.qb.get(id) : null, e = type === 'vehicle_event' ? byId.event.get(id) : null
    if (r) return view.receipt(r as (typeof receipts)[number]); if (t) return view.txn(t as (typeof txns)[number]); if (c) return view.check(c)
    if (q) return view.qb(q as (typeof qb)[number]); if (e) return view.event(e as (typeof events)[number])
    if (type === 'obligation') { const o = obligations.find((x) => x.id === id); if (o) return { type, id, title: `Expected bill — ${o.vendor}`, detail: o.frequency ?? '', amountCents: o.amountCents ?? o.avgAmountCents, date: null } }
    return { type, id, title: 'Record outside this window', detail: '', amountCents: null, date: null }
  }
  const confirmed: ConfirmedMatch[] = [
    ...confirmedLinks.map((l: LinkRow) => ({ linkId: l.id, kind: l.kind as LinkKind, kindLabel: LINK_KINDS[l.kind as LinkKind]?.label ?? l.kind, a: viewOf(l.aType, l.aId), b: viewOf(l.bType, l.bId), decidedBy: l.decidedBy, decidedAt: l.decidedAt.toISOString() })),
    ...receiptMatches.filter((m) => m.txnId).map((m) => ({ linkId: null, kind: 'receipt_txn' as const, kindLabel: 'Receipt ↔ bank payment', a: viewOf('receipt', m.receiptId), b: viewOf('bank_txn', m.txnId as string), decidedBy: m.matchedBy, decidedAt: m.matchedAt.toISOString() })),
  ].sort((x, y) => (y.decidedAt ?? '').localeCompare(x.decidedAt ?? ''))

  // ---- counted once ----
  const nodes: PurchaseNode[] = [
    ...winReceipts.filter((r) => r.totalCents != null).map((r) => ({ key: nodeKey('receipt', r.id), source: 'receipt' as const, id: r.id, amountCents: r.totalCents as number, date: r.receiptDate, label: r.vendor ?? 'Receipt' })),
    ...txns.filter((t) => inWindow(t.txnDate) && t.isExpense && isPurchaseTxnClass(t.txnClass)).map((t) => ({ key: nodeKey('bank_txn', t.id), source: 'bank_txn' as const, id: t.id, amountCents: t.amountCents, date: t.txnDate, label: t.merchantName || t.name || 'Bank payment' })),
    ...winChecks.filter((c) => c.qbStatus === 'recorded' && !isPeopleCheck(c)).map((c) => ({ key: nodeKey('check', c.id), source: 'check' as const, id: c.id, amountCents: c.amountCents, date: c.checkDate, label: `Check #${c.checkNumber} ${c.payeeName}` })),
    ...qb.filter((q) => inWindow(q.txnDate) && !peopleQbKeys.has(q.qbKey)).map((q) => ({ key: nodeKey('qb_purchase', q.qbKey), source: 'qb_purchase' as const, id: q.qbKey, amountCents: q.totalCents, date: q.txnDate, label: q.payeeName ?? 'QuickBooks entry' })),
    ...events.filter((e) => inWindow(e.eventDate)).map((e) => ({ key: nodeKey('vehicle_event', e.id), source: 'vehicle_event' as const, id: e.id, amountCents: e.amountCents, date: e.eventDate, label: e.vendor ?? e.economicCategory })),
  ]
  const src = { receipt: 'receipt', qb_purchase: 'qb_purchase', vehicle_event: 'vehicle_event', check: 'check', bank_txn: 'bank_txn' } as const
  const edges: PurchaseEdge[] = [
    ...confirmedLinks.filter((l) => l.kind !== 'bill_payment').map((l) => ({ a: nodeKey(src[l.aType as keyof typeof src], l.aId), b: nodeKey(src[l.bType as keyof typeof src], l.bId) })),
    ...receiptMatches.filter((m) => m.txnId).map((m) => ({ a: nodeKey('receipt', m.receiptId), b: nodeKey('bank_txn', m.txnId as string) })),
    ...checksAll.filter((c) => c.qboTxnId).map((c) => ({ a: nodeKey('check', c.id), b: nodeKey('qb_purchase', `Purchase:${c.qboTxnId}`) })),
  ]
  const ledger = countOnce(nodes, edges)

  // ---- cash movements that are not purchases ----
  const moves = new Map<string, CashMovement>()
  for (const t of txns) {
    if (!inWindow(t.txnDate) || isPurchaseTxnClass(t.txnClass)) continue
    const k = t.txnClass ?? 'other'
    const m = moves.get(k) ?? { txnClass: k, label: CLASS_LABEL[k] ?? k, count: 0, cents: 0 }
    m.count++; m.cents += t.amountCents; moves.set(k, m)
  }

  // …plus people-checks: counted from the check itself, or from a QuickBooks employee entry no app check created.
  const appCheckKeys = new Set(checksAll.filter((c) => c.qboTxnId).map((c) => `Purchase:${c.qboTxnId}`))
  const people = [
    ...winChecks.filter(isPeopleCheck).map((c) => c.amountCents),
    ...qb.filter((q) => inWindow(q.txnDate) && q.payeeType === 'Employee' && !appCheckKeys.has(q.qbKey)).map((q) => q.totalCents),
  ]
  if (people.length) moves.set('people_checks', { txnClass: 'people_checks', label: CLASS_LABEL.people_checks, count: people.length, cents: people.reduce((s, c) => s + c, 0) })

  const qbSummary = (lastQbo[0]?.summary as { qbPurchases?: { ok?: boolean; skipped?: string; purchases?: number; bills?: number } } | null)?.qbPurchases
  const coverage: SourceCoverage[] = [
    { key: 'bank', label: 'Bank and card feed', state: bankThrough ? (Math.round((utc(today) - utc(bankThrough)) / DAY) > 3 ? 'stale' : 'ok') : 'unavailable', detail: bankThrough ? `Shows transactions through ${bankThrough}. Anything later is not yet observable — it may or may not have posted.` : 'No bank transactions are loaded.' },
    { key: 'qb', label: 'QuickBooks expense entries (read-only)', state: qbAll.length ? 'ok' : 'unavailable',
      detail: qbAll.length ? `${qb.length} purchases/bills read from QuickBooks since ${wideStart}${lastQbo[0]?.at ? ` (last sync ${new Date(lastQbo[0].at).toISOString().slice(0, 10)})` : ''}. This app only reads them; it never posts or edits.`
        : qbSummary?.skipped ? `Not read: ${qbSummary.skipped}.` : 'Not read yet — the next daily QuickBooks sync (09:00 UTC) or “Sync now” on the Finance page fills this in.' },
    { key: 'checks', label: 'Written checks', state: 'ok', detail: `${winChecks.length} in this window. Each recorded check is already its own QuickBooks entry; it still needs matching to the bank payment when it clears.` },
    { key: 'vehicle', label: 'Sales-inventory vehicle costs', state: 'partial', detail: `${events.filter((e) => inWindow(e.eventDate)).length} cost lines in this window. A separate list: a receipt for the same purchase must be matched here or it shows twice.` },
    { key: 'receipts', label: 'Receipts', state: 'ok', detail: `${winReceipts.length} filed in this window. Only purchases someone captured.` },
  ]
  suggestions.sort((x, y) => (x.strength === y.strength ? 0 : x.strength === 'strong' ? -1 : 1) || (y.a.date ?? '').localeCompare(x.a.date ?? ''))
  const paid = bills.filter((b) => b.state === 'paid_confirmed')
  return {
    today, windowStart, days, suggestions: suggestions.slice(0, SUGGESTION_LIMIT), suggestionsTotal: suggestions.length, confirmed, bills,
    billsExpectedCents: bills.reduce((s, b) => s + (b.expectedCents ?? 0), 0), billsPaidConfirmedCents: paid.reduce((s, b) => s + (b.payment?.amountCents ?? 0), 0),
    ledger, cashMovements: [...moves.values()].sort((a, b) => b.cents - a.cents), coverage,
  }
}
export { money as formatCents }

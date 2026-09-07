/**
 * CFO Phase 2 — expected-inflow pipeline. Money we EXPECT before it lands in Plaid, each with a
 * confidence level, derived from REAL evidence (historical *2649 deposit patterns + the PSOS job
 * pipeline). These feed the forecast/scenario layer ONLY — never strict Safe-to-Spend.
 *
 * Confidence: HIGH (recurring dealer deposits, near-daily card settlements) · PROBABLE (retail work
 * ready for pickup) · PIPELINE (work not yet done). We do NOT invent amounts: dealer + card figures
 * come from trailing averages of the bank's own deposit history; anything without a defensible
 * amount is surfaced as a count with unknown value, not a fabricated dollar figure.
 * Read-only toward QuickBooks; no money movement.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finTransactions, finExpectedInflows, finEvents } from './schema'
import { getOperatingCash } from './db'

const iso = (d: Date) => d.toISOString().slice(0, 10)
function nextWeekday(from: Date, dow: number): Date { const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); const diff = (dow - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + diff); return d }
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2) }

// ── Baseline classification (pure, tested) ────────────────────────────────────
// The historical baseline must model OPERATING BUSINESS INFLOW, not every credit to *2649.
export type InflowKind = 'card' | 'qb_payments' | 'transfer' | 'refund' | 'deposit'
export function classifyInflow(name: string | null): InflowKind {
  const n = (name ?? '').toLowerCase()
  if (/from checking|to checking|\btransfer\b|xfer/.test(n)) return 'transfer'                       // internal moves — NOT revenue
  if (/\brefund|reversal|\breturn\b|pos cre|o'?\s?reilly|napa|autozone|advance auto/.test(n)) return 'refund' // vendor credits/returns — NOT new sales
  if (/mer bnkcd|bankcard|merch/.test(n)) return 'card'                                               // Clover/card settlement (revenue)
  if (/intuit.*pymt|pymt soln|intuitpmts|deposit intuit/.test(n)) return 'qb_payments'               // QB Payments settlement (revenue)
  return 'deposit'                                                                                    // dealer checks / cash / generic (revenue)
}
export const isOperatingRevenue = (k: InflowKind) => k === 'card' || k === 'qb_payments' || k === 'deposit'
/** Card weekly run-rate → per-business-day. Denominator is the 6 operating days (Mon–Sat), NOT the
 *  count of days that happened to settle — the old bug that overstated card inflow. */
export function cardDailyFromWeekly(weeklyCardCents: number): number { return Math.round(weeklyCardCents / 6) }

/**
 * Regenerate DERIVED expected inflows from evidence. Manual rows (derived=false) are left untouched.
 *  - dealer_weekly (HIGH): trailing median of weekly NON-card deposits, placed on the modal deposit
 *    weekday (historically Friday). Captures Sterling + dealer/retail checks.
 *  - card_baseline (HIGH): trailing daily-average card (MER BNKCD) settlement, one per upcoming
 *    business day. Retail detailing card revenue.
 */
export async function deriveExpectedInflows(actor: string | null, horizonDays = 21): Promise<{ dealerWeeklyCents: number; cardDailyCents: number; rows: number }> {
  const db = getDb()
  const opId = (await opAccountId()) // operating *2649 fin_account id
  const now = new Date(); const end = new Date(Date.now() + horizonDays * 86400_000)

  // Trailing 60d inflows on *2649 — raw rows so we can classify OPERATING REVENUE vs non-revenue.
  const since = iso(new Date(Date.now() - 60 * 86400_000))
  const raw = opId ? await db.select({
    dow: sql<number>`extract(dow from ${finTransactions.txnDate})::int`,
    wk: sql<string>`to_char(date_trunc('week', ${finTransactions.txnDate}), 'IYYY-IW')`,
    cents: sql<number>`(-${finTransactions.amountCents})::int`,
    name: finTransactions.name,
  }).from(finTransactions).where(and(eq(finTransactions.finAccountId, opId), eq(finTransactions.direction, 'in'), eq(finTransactions.removed, false), gte(finTransactions.txnDate, since))) : []

  // Classify; EXCLUDE internal transfers + refunds/vendor-credits. Keep card + QB Payments + generic
  // deposits as operating revenue (QB Payments ARE real customer revenue — not removed).
  const rows = raw.map((r) => ({ ...r, kind: classifyInflow(r.name) })).filter((r) => isOperatingRevenue(r.kind))

  // NON-CARD operating-revenue weekly totals → dealer/deposit weekly run-rate (median of complete weeks).
  const nonCard = rows.filter((r) => r.kind !== 'card')
  const nonCardWeek = new Map<string, number>()
  for (const r of nonCard) nonCardWeek.set(r.wk, (nonCardWeek.get(r.wk) ?? 0) + r.cents)
  const nonCardWeekly = [...nonCardWeek.values()].sort((a, b) => b - a)
  const dealerWeeklyCents = nonCardWeekly.length >= 3 ? median(nonCardWeekly.slice(0, -1)) : median(nonCardWeekly) // drop partial current week
  // Modal non-card deposit weekday (fallback Friday=5).
  const dowCount: Record<number, number> = {}
  for (const r of nonCard) dowCount[r.dow] = (dowCount[r.dow] ?? 0) + 1
  const modalDow = Object.entries(dowCount).sort((a, b) => b[1] - a[1])[0]?.[0]
  const depositDow = modalDow != null ? Number(modalDow) : 5

  // CARD weekly totals → median weekly card run-rate → per BUSINESS-DAY over the 6 operating days
  // (Mon–Sat). Using a robust weekly median (not a per-settlement-day average) fixes the prior
  // overstatement that divided by only the days that happened to settle.
  const card = rows.filter((r) => r.kind === 'card')
  const cardWeek = new Map<string, number>()
  for (const r of card) cardWeek.set(r.wk, (cardWeek.get(r.wk) ?? 0) + r.cents)
  const cardWeekly = [...cardWeek.values()].sort((a, b) => b - a)
  const cardWeeklyCents = cardWeekly.length >= 3 ? median(cardWeekly.slice(0, -1)) : median(cardWeekly)
  const cardDailyCents = cardDailyFromWeekly(cardWeeklyCents)

  // Clear prior derived rows, re-insert fresh ones across the horizon.
  await db.delete(finExpectedInflows).where(eq(finExpectedInflows.derived, true))
  let inserted = 0
  // Dealer/deposit weekly on each upcoming modal-weekday.
  if (dealerWeeklyCents > 0) {
    for (let d = nextWeekday(now, depositDow); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
      await db.insert(finExpectedInflows).values({
        source: 'dealer_weekly', label: 'Dealer/deposit run-rate (deposit-history pattern)', amountCents: dealerWeeklyCents,
        expectedDate: iso(d), confidence: 'high', refType: 'pattern',
        evidence: { basis: 'trailing median of weekly NON-CARD operating-revenue deposits (60d); internal transfers + refunds EXCLUDED, QB Payments included', nonCardWeekly, depositDow } as any,
        dedupeKey: `dealer_weekly:${iso(d)}`, derived: true, status: 'projected',
      }).onConflictDoNothing()
      inserted++
    }
  }
  // Card baseline each upcoming business day (Mon–Sat).
  if (cardDailyCents > 0) {
    for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dw = d.getUTCDay(); if (dw === 0) continue // skip Sunday
      await db.insert(finExpectedInflows).values({
        source: 'card_baseline', label: 'Retail card run-rate (settlement-history pattern)', amountCents: cardDailyCents,
        expectedDate: iso(d), confidence: 'high', refType: 'pattern',
        evidence: { basis: 'median weekly card (MER BNKCD) settlement (60d) ÷ 6 operating days', cardWeeklyCents, cardDailyCents } as any,
        dedupeKey: `card_baseline:${iso(d)}`, derived: true, status: 'projected',
      }).onConflictDoNothing()
      inserted++
    }
  }
  await db.insert(finEvents).values({ actor, action: 'expected_inflows_derived', entity: 'fin_expected_inflows', source: 'derived', after: { dealerWeeklyCents, cardDailyCents, inserted } as any })
  return { dealerWeeklyCents, cardDailyCents, rows: inserted }
}

async function opAccountId(): Promise<string | null> {
  const op = await getOperatingCash(); return op?.finAccountId ?? null
}

export async function addManualInflow(input: { label: string; amountCents: number; expectedDate: string; confidence: 'high' | 'probable' | 'pipeline'; notes?: string }, actor: string | null) {
  const db = getDb()
  const [row] = await db.insert(finExpectedInflows).values({
    source: 'manual', label: input.label, amountCents: input.amountCents, expectedDate: input.expectedDate,
    confidence: input.confidence, derived: false, status: 'projected', enteredBy: actor, notes: input.notes ?? null,
  }).returning({ id: finExpectedInflows.id })
  await db.insert(finEvents).values({ actor, action: 'expected_inflow_added', entity: 'fin_expected_inflows', entityId: row.id, after: input as any, source: 'manual' })
  return row.id
}
export async function dismissInflow(id: string, actor: string | null) {
  const db = getDb()
  await db.update(finExpectedInflows).set({ status: 'dismissed', updatedAt: new Date() }).where(eq(finExpectedInflows.id, id))
  await db.insert(finEvents).values({ actor, action: 'expected_inflow_dismissed', entity: 'fin_expected_inflows', entityId: id, source: 'manual' })
}

export interface InflowRow { id: string; source: string; label: string; amountCents: number; expectedDate: string; confidence: 'high' | 'probable' | 'pipeline'; derived: boolean }
export async function getExpectedInflows(horizonDays = 21): Promise<InflowRow[]> {
  const db = getDb()
  const end = iso(new Date(Date.now() + horizonDays * 86400_000))
  const rows = await db.select().from(finExpectedInflows)
    .where(and(sql`${finExpectedInflows.status} <> 'dismissed'`, sql`${finExpectedInflows.expectedDate} <= ${end}`))
    .orderBy(finExpectedInflows.expectedDate)
  return rows.map((r) => ({ id: r.id, source: r.source, label: r.label, amountCents: r.amountCents, expectedDate: r.expectedDate, confidence: r.confidence as any, derived: r.derived }))
}

/** PSOS pipeline context (counts) — real work that will become cash. Amounts often not on the order
 *  (dealer flat-rate / unpriced), so we surface COUNTS as evidence, not fabricated dollars. */
export async function getPipelineContext(): Promise<{ readyRetail: number; activeDealer: number; dealerThisWeek: number }> {
  const db = getDb()
  const readyRetail = Number((await db.execute(sql`select count(*)::int n from service_orders where cancelled_at is null and delivered_at is null and status = 'ready' and coalesce(service_type,'') <> 'dealer_detail'`)).rows?.[0]?.n ?? 0)
  const activeDealer = Number((await db.execute(sql`select count(*)::int n from service_orders where cancelled_at is null and delivered_at is null and service_type = 'dealer_detail'`)).rows?.[0]?.n ?? 0)
  const dealerThisWeek = Number((await db.execute(sql`select count(*)::int n from service_orders where cancelled_at is null and service_type = 'dealer_detail' and created_at >= date_trunc('week', now())`)).rows?.[0]?.n ?? 0)
  return { readyRetail, activeDealer, dealerThisWeek }
}

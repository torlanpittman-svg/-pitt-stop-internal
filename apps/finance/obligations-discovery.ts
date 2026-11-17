/**
 * CFO Phase 2 — recurring-obligation discovery. Scans the operating account's outflow history and
 * PROPOSES recurring obligations (evidence + confidence). Proposals are never authoritative: the
 * owner Confirms / Edits / Ignores. Re-runs update a stream in place (discovery_key) and never
 * override an owner's confirmed/ignored decision. No QuickBooks writes; no money movement.
 */
import { and, eq, desc, isNull } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finAccounts, finTransactions, finObligations, finEvents } from './schema'

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const normKey = (name: string) => name.toLowerCase().replace(/[0-9]{2,}/g, '#').replace(/\s+/g, ' ').replace(/#[\/\-]#([\/\-]#)?/g, '#').trim().slice(0, 90)
const cadence = (medGapDays: number): { freq: string; periodDays: number } => {
  if (medGapDays <= 0) return { freq: 'irregular', periodDays: 30 }
  if (medGapDays <= 10) return { freq: 'weekly', periodDays: 7 }
  if (medGapDays <= 20) return { freq: 'biweekly', periodDays: 14 }
  if (medGapDays <= 45) return { freq: 'monthly', periodDays: 30 }
  if (medGapDays <= 100) return { freq: 'quarterly', periodDays: 91 }
  return { freq: 'irregular', periodDays: Math.round(medGapDays) }
}

/** PURE: which fields a discovery re-run may overwrite. Only a still-'proposed' row is rewritten whole. */
export function discoveryUpdate<C extends object, O extends object>(status: string, full: C, observedOnly: O): C | O {
  return status === 'proposed' ? full : observedOnly
}

/** PURE: of several unkeyed copies of one stream, keep the one carrying an owner decision (so an "ignore"
 *  sticks and is not re-proposed); otherwise the newest (input is newest-first). */
export function pickRowToAdopt<T extends { status: string }>(rows: T[]): T | undefined {
  const rank = (s: string) => (s === 'confirmed' ? 0 : s === 'paused' ? 1 : s === 'ignored' ? 2 : 3)
  return rows.slice().sort((a, b) => rank(a.status) - rank(b.status))[0]
}

/**
 * PURE: the proposals worth showing. Collapses the duplicate copies an earlier bug wrote (same vendor, amount
 * and frequency → newest kept) and drops a proposal whose vendor the owner already confirmed, paused or ignored.
 * Read-only: nothing is deleted. `hidden` is how many rows were folded away.
 */
export function visibleProposals<T extends { status: string; vendor: string; amountCents: number | null; frequency: string | null; asOf: Date | null }>(all: T[]): { proposed: T[]; hidden: number } {
  const key = (v: string) => v.trim().toLowerCase()
  const decided = new Set(all.filter((o) => o.status !== 'proposed').map((o) => key(o.vendor)))
  const raw = all.filter((o) => o.status === 'proposed')
  const best = new Map<string, T>()
  for (const o of raw) {
    if (decided.has(key(o.vendor))) continue
    const k = `${key(o.vendor)}|${o.amountCents ?? ''}|${o.frequency ?? ''}`
    const cur = best.get(k)
    if (!cur || (o.asOf?.getTime() ?? 0) > (cur.asOf?.getTime() ?? 0)) best.set(k, o)
  }
  const proposed = [...best.values()]
  return { proposed, hidden: raw.length - proposed.length }
}

export interface DiscoveryResult { proposed: number; updated: number; streams: number }

export async function discoverObligations(actor: string | null): Promise<DiscoveryResult> {
  const db = getDb()
  const [op] = await db.select().from(finAccounts).where(and(eq(finAccounts.status, 'active'), eq(finAccounts.isCash, true))).orderBy(finAccounts.name)
  // Operating = the *2649 account specifically.
  const opAcct = (await db.select().from(finAccounts).where(eq(finAccounts.status, 'active'))).find((a) => /2649/.test(a.name)) ?? op
  if (!opAcct) return { proposed: 0, updated: 0, streams: 0 }

  const txns = await db.select().from(finTransactions)
    .where(and(eq(finTransactions.finAccountId, opAcct.id), eq(finTransactions.direction, 'out'), eq(finTransactions.removed, false)))
  // Group into streams by merchant or normalized name.
  const streams = new Map<string, typeof txns>()
  for (const t of txns) {
    const key = (t.merchantName && t.merchantName.trim()) ? t.merchantName.trim().toLowerCase() : normKey(t.name ?? 'unknown')
    if (!key || key === 'unknown') continue
    if (!streams.has(key)) streams.set(key, [])
    streams.get(key)!.push(t)
  }

  let proposed = 0, updated = 0
  for (const [key, ts] of streams) {
    if (ts.length < 3) continue // need a repeating pattern
    const sorted = ts.slice().sort((a, b) => a.txnDate.localeCompare(b.txnDate))
    const dates = sorted.map((t) => new Date(t.txnDate + 'T00:00:00Z').getTime())
    const gaps: number[] = []; for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86400_000)
    const medGap = median(gaps.filter((g) => g > 0))
    const { freq, periodDays } = cadence(medGap)
    const amounts = sorted.map((t) => Math.abs(t.amountCents))
    const avg = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length)
    const amountMin = Math.min(...amounts), amountMax = Math.max(...amounts)
    const dow = sorted.map((t) => new Date(t.txnDate + 'T00:00:00Z').getUTCDay())
    const modalDow = dow.sort((a, b) => dow.filter((v) => v === a).length - dow.filter((v) => v === b).length).pop() ?? null
    const lastSeen = sorted[sorted.length - 1].txnDate
    const nextDue = new Date(new Date(lastSeen + 'T00:00:00Z').getTime() + periodDays * 86400_000).toISOString().slice(0, 10)
    const classes = new Set(sorted.map((t) => t.txnClass))
    const vendor = (sorted.find((t) => t.merchantName)?.merchantName) ?? key
    // Category + priority from the observed classes / name.
    // Payroll and owner_draw are OWNER-CONFIRMED seeds — never auto-propose them (would double-count).
    if (classes.has('payroll') || classes.has('owner_draw') || /payroll|owner draw|to checking xx?0169/i.test(key)) continue
    let category = 'other', critical = false, priority: 'critical' | 'contractual' | 'planned' = 'contractual'
    if (classes.has('debt_payment')) { category = 'debt'; critical = true; priority = 'critical' }
    else if (/rent|4183|holding/i.test(key)) { category = 'rent'; critical = true; priority = 'contractual' }
    else if (classes.has('card_payment')) { category = 'card_payment'; priority = 'contractual' }
    else if (/insur|premium finance/i.test(key)) { category = 'insurance'; priority = 'contractual' }
    else if (/water|electric|city of|utilit|internet|wirestar|comcast|at&t|verizon/i.test(key)) { category = 'utilities'; priority = 'contractual' }
    else if (/google|adobe|intuit|autoleap|software|saas|subscription|prime/i.test(key)) { category = 'software'; priority = 'planned' }
    else priority = 'contractual'

    const discoveryKey = `op:${key}`.slice(0, 140)
    const evidence = { key, occurrences: ts.length, medianGapDays: medGap, freq, avg, amountMin, amountMax, modalDow, lastSeen, classes: [...classes], sample: sorted.slice(-3).map((t) => ({ date: t.txnDate, amt: t.amountCents, name: (t.merchantName || t.name || '').slice(0, 40) })) }

    // One row per stream. The key was never written on insert, so every run failed to find yesterday's row and
    // inserted another copy (≈95 copies of each vendor by 2026-11). Rows created before the fix have no key, so
    // an unkeyed discovery row for the same vendor is adopted instead of duplicated again.
    let existing: typeof finObligations.$inferSelect | undefined = (await db.select().from(finObligations).where(eq(finObligations.discoveryKey, discoveryKey)).limit(1))[0]
    if (!existing) {
      const unkeyed = await db.select().from(finObligations)
        .where(and(isNull(finObligations.discoveryKey), eq(finObligations.source, 'discovery'), eq(finObligations.vendor, String(vendor).slice(0, 200))))
        .orderBy(desc(finObligations.asOf))
      existing = pickRowToAdopt(unkeyed)
    }
    const observed = { avgAmountCents: avg, amountMinCents: amountMin, amountMaxCents: amountMax, occurrences: ts.length, lastSeen, evidence: evidence as any, asOf: new Date(), discoveryKey }
    const common = {
      ...observed, vendor: String(vendor).slice(0, 200), category, amountCents: avg,
      frequency: freq, nextDue, essential: critical, dayOfWeek: modalDow, critical, priority,
      source: 'discovery', confidence: 'estimated',
    }
    if (existing) {
      // A decision the owner made (confirmed / paused / ignored) keeps ITS amount, schedule, category and
      // priority; only what the bank shows (evidence, average, last seen) is refreshed. A proposal is refreshed whole.
      await db.update(finObligations).set(discoveryUpdate(existing.status, common, observed)).where(eq(finObligations.id, existing.id))
      updated++
    } else {
      await db.insert(finObligations).values({ ...common, status: 'proposed', enteredBy: 'discovery' })
      proposed++
    }
  }
  await db.insert(finEvents).values({ actor, action: 'obligations_discovered', entity: 'fin_obligations', source: 'plaid', after: { proposed, updated, streams: streams.size } as any })
  return { proposed, updated, streams: streams.size }
}

export async function setObligationStatus(id: string, status: 'confirmed' | 'paused' | 'ignored' | 'proposed', actor: string | null) {
  const db = getDb()
  await db.update(finObligations).set({ status }).where(eq(finObligations.id, id))
  await db.insert(finEvents).values({ actor, action: 'obligation_status', entity: 'fin_obligations', entityId: id, after: { status } as any, source: 'manual' })
}

export async function getObligationsByStatus() {
  const all = await getDb().select().from(finObligations).orderBy(desc(finObligations.critical), desc(finObligations.avgAmountCents))
  const { proposed, hidden } = visibleProposals(all)
  return {
    confirmed: all.filter((o) => o.status === 'confirmed'),
    proposed, hiddenDuplicateProposals: hidden,
    ignored: all.filter((o) => o.status === 'ignored' || o.status === 'paused'),
  }
}

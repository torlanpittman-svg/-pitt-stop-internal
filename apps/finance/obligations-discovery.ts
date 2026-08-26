/**
 * CFO Phase 2 — recurring-obligation discovery. Scans the operating account's outflow history and
 * PROPOSES recurring obligations (evidence + confidence). Proposals are never authoritative: the
 * owner Confirms / Edits / Ignores. Re-runs update a stream in place (discovery_key) and never
 * override an owner's confirmed/ignored decision. No QuickBooks writes; no money movement.
 */
import { and, eq, desc } from 'drizzle-orm'
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
    // Category + criticality from the observed classes / name.
    let category = 'other', critical = false
    if (classes.has('debt_payment')) { category = 'debt'; critical = true }
    else if (/rent|4183|holding/i.test(key)) { category = 'rent'; critical = true }
    else if (classes.has('payroll') || /payroll|check in clearings/i.test(key)) { category = 'payroll'; critical = true }
    else if (classes.has('card_payment')) category = 'card_payment'
    else if (/insur/i.test(key)) category = 'insurance'
    else if (/water|electric|city of|utilit|internet|wirestar|comcast|at&t|verizon/i.test(key)) category = 'utilities'
    else if (/google|adobe|intuit|autoleap|software|saas|subscription|prime/i.test(key)) category = 'software'

    const discoveryKey = `op:${key}`.slice(0, 140)
    const evidence = { key, occurrences: ts.length, medianGapDays: medGap, freq, avg, amountMin, amountMax, modalDow, lastSeen, classes: [...classes], sample: sorted.slice(-3).map((t) => ({ date: t.txnDate, amt: t.amountCents, name: (t.merchantName || t.name || '').slice(0, 40) })) }

    const [existing] = await db.select().from(finObligations).where(eq(finObligations.discoveryKey, discoveryKey)).limit(1)
    const common = {
      vendor: String(vendor).slice(0, 200), category, amountCents: avg, amountMinCents: amountMin, amountMaxCents: amountMax,
      frequency: freq, nextDue, essential: critical, avgAmountCents: avg, occurrences: ts.length, lastSeen, dayOfWeek: modalDow, critical,
      evidence: evidence as any, source: 'discovery', confidence: 'estimated', asOf: new Date(),
    }
    if (existing) {
      // Preserve the owner's decision (confirmed/paused/ignored); only refresh evidence/figures.
      await db.update(finObligations).set(common).where(eq(finObligations.id, existing.id))
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
  return {
    confirmed: all.filter((o) => o.status === 'confirmed'),
    proposed: all.filter((o) => o.status === 'proposed'),
    ignored: all.filter((o) => o.status === 'ignored' || o.status === 'paused'),
  }
}

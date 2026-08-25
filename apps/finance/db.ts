/**
 * CFO Financial OS — read models + manual writes (Phase 1). Read-only toward QuickBooks; the
 * only writes are to fin_* tables (manual payroll / obligation / document metadata), each
 * audited in fin_events. Every money figure returned carries source + as-of + confidence.
 */
import { desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finAccounts, finBalanceSnapshots, finDebts, finPayroll, finObligations, finDocuments, finSyncRuns, finEvents, finPlaidItems, finPlaidAccounts } from './schema'
import { money, type MoneyValue } from './sources'
import { encrypt } from '@/apps/quickbooks/crypto'
import { getItemInstitution, getAccountBalances, plaidEnv, type PlaidAccountBalance } from './plaid'

export interface AccountView {
  id: string; name: string; kind: string; institution: string | null; clearingSuspect: boolean
  accountType: string | null; balance: MoneyValue | null
}

/** Accounts (cash / card / clearing) with their latest BOOK balance snapshot. */
export async function getAccounts(): Promise<AccountView[]> {
  const db = getDb()
  const accts = await db.select().from(finAccounts).orderBy(finAccounts.kind, finAccounts.name)
  const out: AccountView[] = []
  for (const a of accts) {
    const [snap] = await db.select().from(finBalanceSnapshots).where(eq(finBalanceSnapshots.accountId, a.id)).orderBy(desc(finBalanceSnapshots.asOf)).limit(1)
    out.push({
      id: a.id, name: a.name, kind: a.kind, institution: a.institution, clearingSuspect: a.clearingSuspect,
      accountType: a.accountType,
      balance: snap ? money(snap.balanceCents, snap.source as any, snap.asOf, snap.confidence as any) : null,
    })
  }
  return out
}

export async function getDebts() {
  return getDb().select().from(finDebts).orderBy(desc(finDebts.principalCents))
}
export async function getLatestPayroll() {
  const [p] = await getDb().select().from(finPayroll).orderBy(desc(finPayroll.asOf)).limit(1)
  return p ?? null
}
export async function getObligations() {
  return getDb().select().from(finObligations).orderBy(desc(finObligations.asOf))
}
export async function getDocuments() {
  return getDb().select().from(finDocuments).orderBy(desc(finDocuments.createdAt))
}
export async function getLatestSyncRun() {
  const [r] = await getDb().select().from(finSyncRuns).orderBy(desc(finSyncRuns.startedAt)).limit(1)
  return r ?? null
}

// ── Manual writes (audited) ──────────────────────────────────────────────────
async function audit(actor: string | null, action: string, entity: string, entityId: string | null, after: unknown) {
  await getDb().insert(finEvents).values({ actor, action, entity, entityId, after: after as any, source: 'manual' })
}

export async function setNextPayroll(input: { nextPayDate: string; expectedCashCents: number; frequency?: string; notes?: string }, actor: string | null) {
  const [row] = await getDb().insert(finPayroll).values({
    nextPayDate: input.nextPayDate, expectedCashCents: input.expectedCashCents,
    frequency: input.frequency ?? 'weekly', source: 'manual', confidence: 'manual', enteredBy: actor, notes: input.notes ?? null,
  }).returning({ id: finPayroll.id })
  await audit(actor, 'payroll_set', 'fin_payroll', row.id, input)
  return row.id
}

export async function addObligation(input: { vendor: string; category?: string; amountCents?: number; frequency?: string; nextDue?: string; essential?: boolean; notes?: string }, actor: string | null) {
  const [row] = await getDb().insert(finObligations).values({
    vendor: input.vendor, category: input.category ?? null, amountCents: input.amountCents ?? null,
    frequency: input.frequency ?? null, nextDue: input.nextDue ?? null, essential: input.essential ?? null,
    source: 'manual', confidence: 'manual', status: 'confirmed', enteredBy: actor, notes: input.notes ?? null,
  }).returning({ id: finObligations.id })
  await audit(actor, 'obligation_added', 'fin_obligations', row.id, input)
  return row.id
}

export async function addDocumentMeta(input: { type: string; blobUrl: string; filename?: string; accountId?: string; debtId?: string; periodStart?: string; periodEnd?: string; asOf?: string; notes?: string }, actor: string | null) {
  const [row] = await getDb().insert(finDocuments).values({
    type: input.type, blobUrl: input.blobUrl, filename: input.filename ?? null,
    accountId: input.accountId ?? null, debtId: input.debtId ?? null,
    periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null, asOf: input.asOf ?? null,
    source: 'manual', uploadedBy: actor, notes: input.notes ?? null,
  }).returning({ id: finDocuments.id })
  await audit(actor, 'document_added', 'fin_documents', row.id, { type: input.type, filename: input.filename })
  return row.id
}

// ── Plaid (read-only live cash) ──────────────────────────────────────────────
/** After a public-token exchange: store the ENCRYPTED access token + discovered accounts. The
 *  raw access token is never persisted in plaintext and never leaves the server. */
export async function savePlaidConnection(params: { itemId: string; accessToken: string; connectedBy: string | null }): Promise<{ plaidItemRowId: string; institutionName: string | null; accounts: number }> {
  const db = getDb()
  const inst = await getItemInstitution(params.accessToken).catch(() => ({ institutionId: null, name: null }))
  const [row] = await db.insert(finPlaidItems).values({
    itemId: params.itemId, institutionId: inst.institutionId, institutionName: inst.name,
    environment: plaidEnv(), accessTokenEnc: encrypt(params.accessToken), status: 'active', connectedBy: params.connectedBy,
  }).onConflictDoUpdate({
    target: finPlaidItems.itemId,
    set: { institutionId: inst.institutionId, institutionName: inst.name, accessTokenEnc: encrypt(params.accessToken), status: 'active', updatedAt: new Date() },
  }).returning({ id: finPlaidItems.id })
  const balances = await getAccountBalances(params.accessToken)
  await upsertPlaidAccounts(row.id, balances)
  await getDb().insert(finEvents).values({ actor: params.connectedBy, action: 'plaid_connected', entity: 'fin_plaid_items', entityId: params.itemId, source: 'plaid', after: { institution: inst.name, accounts: balances.length } as any })
  return { plaidItemRowId: row.id, institutionName: inst.name, accounts: balances.length }
}

async function upsertPlaidAccounts(itemRowId: string, balances: PlaidAccountBalance[]) {
  const db = getDb()
  for (const b of balances) {
    await db.insert(finPlaidAccounts).values({
      itemId: itemRowId, plaidAccountId: b.plaidAccountId, name: b.name, officialName: b.officialName, mask: b.mask,
      type: b.type, subtype: b.subtype, currentBalanceCents: b.currentCents, availableBalanceCents: b.availableCents,
      currency: b.currency, balanceAsOf: new Date(), raw: b.raw as any,
    }).onConflictDoUpdate({
      target: finPlaidAccounts.plaidAccountId,
      set: { currentBalanceCents: b.currentCents, availableBalanceCents: b.availableCents, balanceAsOf: new Date(), raw: b.raw as any, updatedAt: new Date() },
    })
  }
}

/** Re-pull read-only balances for every connected Item; refresh discovered accounts and write a
 *  fresh LIVE snapshot for any account whose mapping the admin has verified. */
export async function refreshPlaidBalances(actor: string | null): Promise<{ items: number; accounts: number }> {
  const db = getDb()
  const { decrypt } = await import('@/apps/quickbooks/crypto')
  const items = await db.select().from(finPlaidItems).where(eq(finPlaidItems.status, 'active'))
  let accts = 0
  for (const it of items) {
    try {
      const balances = await getAccountBalances(decrypt(it.accessTokenEnc))
      await upsertPlaidAccounts(it.id, balances)
      accts += balances.length
      const mapped = await db.select().from(finPlaidAccounts).where(eq(finPlaidAccounts.itemId, it.id))
      for (const pa of mapped) {
        if (pa.mappingVerified && pa.mappedAccountId && pa.currentBalanceCents != null) {
          await db.insert(finBalanceSnapshots).values({
            accountId: pa.mappedAccountId, balanceCents: pa.currentBalanceCents, availableCents: pa.availableBalanceCents ?? null,
            asOf: new Date(), source: 'plaid', confidence: 'live', raw: { plaidAccountId: pa.plaidAccountId, mask: pa.mask } as any,
          })
        }
      }
      await db.update(finPlaidItems).set({ status: 'active', lastError: null, updatedAt: new Date() }).where(eq(finPlaidItems.id, it.id))
    } catch (e) {
      await db.update(finPlaidItems).set({ status: 'error', lastError: (e instanceof Error ? e.message : String(e)).slice(0, 400), updatedAt: new Date() }).where(eq(finPlaidItems.id, it.id))
    }
  }
  await db.insert(finEvents).values({ actor, action: 'plaid_refresh', entity: 'fin_plaid_items', source: 'plaid', after: { items: items.length, accounts: accts } as any })
  return { items: items.length, accounts: accts }
}

export async function getPlaidConnections() {
  const db = getDb()
  const items = await db.select().from(finPlaidItems).orderBy(desc(finPlaidItems.createdAt))
  const out = []
  for (const it of items) {
    const accts = await db.select().from(finPlaidAccounts).where(eq(finPlaidAccounts.itemId, it.id)).orderBy(finPlaidAccounts.mask)
    out.push({ item: it, accounts: accts })
  }
  return out
}

/** Admin verifies that a Plaid-discovered account corresponds to a specific fin_account (e.g.
 *  QBO *2649). Only then is it "trusted": we link it AND write a LIVE balance snapshot. */
export async function verifyPlaidMapping(params: { plaidAccountId: string; finAccountId: string; actor: string | null }): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const [pa] = await db.select().from(finPlaidAccounts).where(eq(finPlaidAccounts.plaidAccountId, params.plaidAccountId)).limit(1)
  if (!pa) return { ok: false, error: 'Plaid account not found' }
  const [fa] = await db.select().from(finAccounts).where(eq(finAccounts.id, params.finAccountId)).limit(1)
  if (!fa) return { ok: false, error: 'Target account not found' }
  await db.update(finPlaidAccounts).set({ mappedAccountId: fa.id, mappingVerified: true, updatedAt: new Date() }).where(eq(finPlaidAccounts.id, pa.id))
  // Trusted live snapshot onto the mapped fin_account.
  if (pa.currentBalanceCents != null) {
    await db.insert(finBalanceSnapshots).values({
      accountId: fa.id, balanceCents: pa.currentBalanceCents, availableCents: pa.availableBalanceCents ?? null,
      asOf: pa.balanceAsOf ?? new Date(), source: 'plaid', confidence: 'live',
      raw: { plaidAccountId: pa.plaidAccountId, mask: pa.mask } as any,
    })
  }
  await db.update(finAccounts).set({ externalSource: fa.externalSource, updatedAt: new Date() }).where(eq(finAccounts.id, fa.id))
  await db.insert(finEvents).values({ actor: params.actor, action: 'plaid_mapping_verified', entity: 'fin_accounts', entityId: fa.id, source: 'plaid', after: { plaidAccountId: pa.plaidAccountId, mask: pa.mask, account: fa.name } as any })
  return { ok: true }
}

// ── Data Gaps / Required Inputs — generated from ACTUAL known/missing data ────
export interface DataGap { key: string; label: string; severity: 'high' | 'medium' }
export async function getDataGaps(): Promise<DataGap[]> {
  const db = getDb()
  const gaps: DataGap[] = []

  // No live bank/card source connected → cash is book-only.
  const [{ liveCount }] = await db.select({ liveCount: sql<number>`count(*)::int` }).from(finBalanceSnapshots).where(eq(finBalanceSnapshots.confidence, 'live'))
  if (Number(liveCount) === 0) {
    gaps.push({ key: 'extraco_live', label: 'Live Extraco bank balance not connected', severity: 'high' })
    gaps.push({ key: 'amb_live', label: 'Live American Momentum bank balance not connected', severity: 'high' })
    gaps.push({ key: 'amex_live', label: 'Live American Express data (balance / due / min) not connected', severity: 'high' })
  }
  // Next payroll missing → cannot answer "can we make payroll?".
  const payroll = await getLatestPayroll()
  if (!payroll) gaps.push({ key: 'payroll', label: 'Next payroll amount / date not entered', severity: 'high' })

  // Debt terms unverified.
  const debts = await getDebts()
  const unverified = debts.filter((d) => !d.verified)
  if (unverified.some((d) => /extraco/i.test(d.name))) gaps.push({ key: 'extraco_terms', label: 'Extraco loan/LOC terms (APR / payment / maturity) not verified', severity: 'high' })
  if (unverified.some((d) => d.kind === 'floor_plan' || /floor plan/i.test(d.name))) gaps.push({ key: 'floor_plan_terms', label: 'Floor-plan terms not verified', severity: 'high' })
  if (unverified.some((d) => /\bqb\b|quickbooks/i.test(d.name))) gaps.push({ key: 'qb_capital_terms', label: 'QuickBooks Capital loan terms not verified', severity: 'medium' })

  // Obligations not yet discovered.
  const [{ oblCount }] = await db.select({ oblCount: sql<number>`count(*)::int` }).from(finObligations)
  if (Number(oblCount) === 0) gaps.push({ key: 'obligations', label: 'Recurring obligations not yet added/discovered', severity: 'medium' })

  // Accounts not mapped to an institution.
  const accts = await db.select({ institution: finAccounts.institution }).from(finAccounts)
  if (accts.length > 0 && accts.some((a) => !a.institution)) gaps.push({ key: 'account_mapping', label: 'Bank accounts not yet mapped to Extraco / American Momentum', severity: 'medium' })

  return gaps
}

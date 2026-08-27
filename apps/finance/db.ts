/**
 * CFO Financial OS — read models + manual writes (Phase 1). Read-only toward QuickBooks; the
 * only writes are to fin_* tables (manual payroll / obligation / document metadata), each
 * audited in fin_events. Every money figure returned carries source + as-of + confidence.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finAccounts, finBalanceSnapshots, finDebts, finPayroll, finObligations, finDocuments, finSyncRuns, finEvents, finPlaidItems, finPlaidAccounts } from './schema'
import { money, isStale, type MoneyValue } from './sources'
import { encrypt } from '@/apps/quickbooks/crypto'
import { getItemInstitution, getAccountBalances, plaidEnv, type PlaidAccountBalance } from './plaid'
import { getReservePolicy } from '@/apps/settings/db'

export interface LiveBalance { currentCents: number | null; availableCents: number | null; asOf: string; mask: string | null; institution: string | null; stale: boolean }
export interface AccountView {
  id: string; name: string; kind: string; institution: string | null; clearingSuspect: boolean
  accountType: string | null; status: string; isCash: boolean
  balance: MoneyValue | null            // QuickBooks BOOK figure — never presented as live cash
  live: LiveBalance | null              // verified Plaid live balance mapped to this account (if any)
}

/**
 * Accounts with BOOK balance (QuickBooks) AND, where a verified Plaid mapping exists, the LIVE
 * institution balance — shown side by side, never substituted. Excludes ignored/closed accounts
 * by default so a stale/nonexistent account (e.g. Savings *3241) never counts as cash.
 */
export async function getAccounts(opts: { includeInactive?: boolean } = {}): Promise<AccountView[]> {
  const db = getDb()
  const accts = await db.select().from(finAccounts).orderBy(finAccounts.kind, finAccounts.name)
  const out: AccountView[] = []
  for (const a of accts) {
    if (!opts.includeInactive && a.status !== 'active') continue
    // BOOK snapshot only (source=qbo) — live 'plaid' snapshots must not masquerade as book.
    const [snap] = await db.select().from(finBalanceSnapshots)
      .where(and(eq(finBalanceSnapshots.accountId, a.id), eq(finBalanceSnapshots.source, 'qbo')))
      .orderBy(desc(finBalanceSnapshots.asOf)).limit(1)
    // LIVE from a verified, active Plaid mapping.
    const [pa] = await db.select().from(finPlaidAccounts)
      .where(and(eq(finPlaidAccounts.mappedAccountId, a.id), eq(finPlaidAccounts.mappingVerified, true), eq(finPlaidAccounts.status, 'active')))
      .limit(1)
    out.push({
      id: a.id, name: a.name, kind: a.kind, institution: a.institution, clearingSuspect: a.clearingSuspect,
      accountType: a.accountType, status: a.status, isCash: a.isCash,
      balance: snap ? money(snap.balanceCents, snap.source as any, snap.asOf, snap.confidence as any) : null,
      live: pa ? {
        currentCents: pa.currentBalanceCents, availableCents: pa.availableBalanceCents,
        asOf: (pa.balanceAsOf ?? new Date()).toISOString(), mask: pa.mask, institution: null,
        stale: isStale(pa.balanceAsOf),
      } : null,
    })
  }
  return out
}

/** The verified live operating-cash foundation for Safe-to-Spend (American Momentum *2649). */
export interface OperatingCash { finAccountId: string; name: string; mask: string | null; currentCents: number | null; availableCents: number | null; asOf: string; stale: boolean }
export async function getOperatingCash(): Promise<OperatingCash | null> {
  const db = getDb()
  // The operating account is the verified Plaid mapping onto the fin_account marked as the
  // Pitt Stop Detail operating checking (isCash bank, external_id qbo:31 / name *2649).
  const rows = await db.select({ pa: finPlaidAccounts, fa: finAccounts })
    .from(finPlaidAccounts)
    .innerJoin(finAccounts, eq(finPlaidAccounts.mappedAccountId, finAccounts.id))
    .where(and(eq(finPlaidAccounts.mappingVerified, true), eq(finPlaidAccounts.status, 'active'), eq(finAccounts.status, 'active')))
  const op = rows.find((r) => /2649/.test(r.fa.name) || /2649/.test(r.pa.mask ?? ''))
  if (!op) return null
  return {
    finAccountId: op.fa.id, name: op.fa.name, mask: op.pa.mask,
    currentCents: op.pa.currentBalanceCents, availableCents: op.pa.availableBalanceCents,
    asOf: (op.pa.balanceAsOf ?? new Date()).toISOString(), stale: isStale(op.pa.balanceAsOf),
  }
}

/** Auto-sales (*5600) liquidity view. Bank cash is NOT freely spendable: some is encumbered by
 *  floor-plan/title/payoff obligations on sold-but-not-cleared vehicles. Until those obligations are
 *  registered, we cannot compute unencumbered cash — we disclose it rather than pretend. */
export interface AutoSalesLiquidity { bankAvailableCents: number | null; asOf: string | null; knownEncumbranceCents: number; encumbranceKnown: boolean; unencumberedCents: number | null; note: string }
export async function getAutoSalesLiquidity(): Promise<AutoSalesLiquidity> {
  const db = getDb()
  const rows = await db.select({ pa: finPlaidAccounts, fa: finAccounts })
    .from(finPlaidAccounts).innerJoin(finAccounts, eq(finPlaidAccounts.mappedAccountId, finAccounts.id))
    .where(and(eq(finPlaidAccounts.mappingVerified, true), eq(finPlaidAccounts.status, 'active')))
  const as = rows.find((r) => /5600/.test(r.fa.name) || /5600/.test(r.pa.mask ?? ''))
  if (!as) return { bankAvailableCents: null, asOf: null, knownEncumbranceCents: 0, encumbranceKnown: false, unencumberedCents: null, note: 'No verified auto-sales account.' }
  // Encumbrances (floor-plan/title/payoff) are not yet registered → treat balance as potentially encumbered.
  return {
    bankAvailableCents: as.pa.availableBalanceCents, asOf: (as.pa.balanceAsOf ?? new Date()).toISOString(),
    knownEncumbranceCents: 0, encumbranceKnown: false, unencumberedCents: null,
    note: 'Floor-plan / title / payoff obligations for recently-sold vehicles are not yet registered — treat this balance as POTENTIALLY ENCUMBERED, not free cash.',
  }
}

/** Mark a Plaid-discovered account active | ignored | closed (connector layer). Audited. */
export async function setPlaidAccountStatus(params: { plaidAccountId: string; status: 'active' | 'ignored' | 'closed'; entityNote?: string | null; actor: string | null }): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const [pa] = await db.select().from(finPlaidAccounts).where(eq(finPlaidAccounts.plaidAccountId, params.plaidAccountId)).limit(1)
  if (!pa) return { ok: false, error: 'Plaid account not found' }
  const set: Record<string, unknown> = { status: params.status, updatedAt: new Date() }
  if (params.entityNote !== undefined) set.entityNote = params.entityNote
  await db.update(finPlaidAccounts).set(set).where(eq(finPlaidAccounts.id, pa.id))
  await db.insert(finEvents).values({ actor: params.actor, action: 'plaid_account_status', entity: 'fin_plaid_accounts', entityId: pa.plaidAccountId, before: { status: pa.status } as any, after: { status: params.status, entityNote: params.entityNote ?? pa.entityNote } as any, source: 'manual' })
  return { ok: true }
}

/** Mark a fin_account active | ignored | closed. Keeps history; removes it from cash + views. Audited. */
export async function setAccountStatus(params: { finAccountId: string; status: 'active' | 'ignored' | 'closed'; actor: string | null }): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const [fa] = await db.select().from(finAccounts).where(eq(finAccounts.id, params.finAccountId)).limit(1)
  if (!fa) return { ok: false, error: 'Account not found' }
  await db.update(finAccounts).set({ status: params.status, active: params.status === 'active', updatedAt: new Date() }).where(eq(finAccounts.id, fa.id))
  await db.insert(finEvents).values({ actor: params.actor, action: 'account_status', entity: 'fin_accounts', entityId: fa.id, before: { status: fa.status } as any, after: { status: params.status } as any, source: 'manual' })
  return { ok: true }
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
export type GapBlocks = 'safe_to_spend' | 'forecast' | 'debt_optimization' | 'confidence'
export interface DataGap {
  key: string
  label: string                 // exactly what is missing
  why: string                   // why the CFO needs it
  source: string                // what should provide it
  blocks: GapBlocks[]           // what it blocks (or only improves)
  severity: 'high' | 'medium' | 'low'
}

/**
 * Fully DYNAMIC data-gap audit — each gap is computed from current verified state and disappears
 * automatically once its requirement is satisfied. Nothing already-established is reported as missing.
 */
export async function getDataGaps(): Promise<DataGap[]> {
  const db = getDb()
  const gaps: DataGap[] = []

  // ── Live bank/card coverage — VERIFIED, active Plaid mappings only ──
  const verified = await db.select({ mask: finPlaidAccounts.mask, name: finPlaidAccounts.name, type: finPlaidAccounts.type })
    .from(finPlaidAccounts).where(and(eq(finPlaidAccounts.mappingVerified, true), eq(finPlaidAccounts.status, 'active')))
  const hasMask = (m: RegExp) => verified.some((v) => m.test(v.mask ?? '') || m.test(v.name ?? ''))
  if (!hasMask(/2649/)) gaps.push({ key: 'amb_live', label: 'American Momentum *2649 operating balance not verified-live', why: 'It is the Safe-to-Spend cash foundation.', source: 'Plaid (verify mapping in Bank Connections)', blocks: ['safe_to_spend', 'forecast'], severity: 'high' })
  if (!hasMask(/5600/)) gaps.push({ key: 'extraco_live', label: 'Extraco *5600 (Auto Sales) balance not verified-live', why: 'Needed for auto-sales liquidity.', source: 'Plaid', blocks: ['confidence'], severity: 'medium' })

  // ── Active bank accounts genuinely unresolved (closed/clearing accounts are NOT gaps) ──
  const activeBanks = await db.select().from(finAccounts).where(and(eq(finAccounts.kind, 'bank'), eq(finAccounts.status, 'active')))
  const unmapped = activeBanks.filter((a) => !a.institution)
  if (unmapped.length > 0) gaps.push({ key: 'account_mapping', label: `Active bank account(s) not mapped to an institution: ${unmapped.map((a) => a.name).join(', ')}`, why: 'Unmapped active cash accounts are excluded from cash math.', source: 'Verify the Plaid mapping', blocks: ['safe_to_spend'], severity: 'medium' })

  // ── Payroll: resolved when confirmed payroll obligations exist (next Friday auto-calculated) ──
  const payrollObls = await db.select().from(finObligations).where(and(eq(finObligations.category, 'payroll'), eq(finObligations.status, 'confirmed')))
  if (payrollObls.length === 0) gaps.push({ key: 'payroll', label: 'Employee payroll not confirmed', why: 'Cannot answer “can we make payroll?” without it.', source: 'QuickBooks Payroll (verified)', blocks: ['safe_to_spend', 'forecast'], severity: 'high' })

  // ── Reserve policy unconfigured → strict Safe-to-Spend can’t be “fully trustworthy” ──
  const reserves = await getReservePolicy()
  if (!reserves.configured) gaps.push({ key: 'reserves', label: 'Reserve policy not configured ($0 assumed)', why: 'No payroll/tax/operating buffer is protected; Safe-to-Spend can’t be fully trusted.', source: 'Owner decision (Reserve policy panel)', blocks: ['safe_to_spend', 'debt_optimization'], severity: 'medium' })

  // ── Debt terms unverified — grouped by lender; only when real principal exists ──
  const debts = await getDebts()
  const unverified = debts.filter((d) => !d.verified && (d.principalCents ?? 0) > 0)
  const extraco = unverified.filter((d) => /extraco/i.test(d.name) && d.kind !== 'floor_plan')
  const floor = unverified.filter((d) => d.kind === 'floor_plan' || /floor plan/i.test(d.name))
  const qb = unverified.filter((d) => /\bqb\b|quickbooks/i.test(d.name))
  const sumC = (xs: typeof debts) => xs.reduce((t, d) => t + (d.principalCents ?? 0), 0)
  if (floor.length) gaps.push({ key: 'floor_plan_terms', label: `Floor-plan terms unverified (${floor.length} line, ~$${(sumC(floor) / 100).toLocaleString()} principal)`, why: 'Floor-plan curtailments/payoffs encumber *5600 auto-sales cash and are committed outflows.', source: 'Extraco “Loan Activity” emails (Nancy) / statements', blocks: ['safe_to_spend', 'debt_optimization'], severity: 'high' })
  if (extraco.length) gaps.push({ key: 'extraco_terms', label: `Extraco loan/LOC terms unverified (${extraco.length} loans, ~$${(sumC(extraco) / 100).toLocaleString()} principal)`, why: 'APR / payment / maturity drive debt service and the debt-vs-reserve optimizer.', source: 'Extraco “Loan Activity” emails (Nancy) / statements', blocks: ['debt_optimization'], severity: 'high' })
  if (qb.length) gaps.push({ key: 'qb_capital_terms', label: `QuickBooks Capital terms unverified (${qb.length} loans, ~$${(sumC(qb) / 100).toLocaleString()} principal)`, why: 'High-APR debt; terms needed to prioritize payoff.', source: 'QuickBooks Capital dashboard', blocks: ['debt_optimization'], severity: 'medium' })

  // ── Auto-sales encumbrance unknown → can’t compute unencumbered *5600 cash ──
  gaps.push({ key: 'autosales_encumbrance', label: 'Auto-sales floor-plan/title/payoff obligations not registered', why: 'Without them, *5600 shows bank cash but “unencumbered” = Unknown; can’t safely backstop *2649.', source: 'Extraco floor-plan + vehicle title/payoff records', blocks: ['confidence'], severity: 'medium' })

  return gaps
}

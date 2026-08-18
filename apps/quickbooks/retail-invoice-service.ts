/**
 * Retail QuickBooks invoice CREATE orchestration (P-D3.1). No send, no email.
 *
 * Idempotency (approved P-D3.0 design), duplicate-proof under double-taps / retries /
 * crashes:
 *   1. local qb_invoice_id present → return existing state, never create again
 *   2. compare-and-set qb_status='creating' WHERE qb_invoice_id IS NULL (one winner)
 *   3. PSID adoption — scan the customer's recent invoices for PSID:<estimateId> and adopt
 *      (covers "QB create succeeded but the local DB write was lost")
 *   4. partial UNIQUE index on qb_invoice_id is the DB backstop
 *
 * The QB invoice is built ONLY from the authoritative Invoice Draft; the invariant
 * TotalAmt === draft total_cents is enforced pre-write (payload builder throws on mismatch)
 * and re-checked post-write. Dealer invoicing is untouched.
 */
import crypto from 'node:crypto'
import { and, eq, isNull, inArray, desc } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { jobEstimates } from '@/apps/workflow/schema'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { getOrderWithContext, logEvent, type OrderWithContext } from '@/apps/workflow/db'
import { getEstimateRow, getFullEstimate, itemizeEstimate, type FullEstimate } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft, type InvoiceDraft } from '@/apps/workflow/invoice-draft'
import { isDealerOrder } from '@/apps/workflow/fees'
import { lineAmountCents } from '@/apps/workflow/estimate'
import { getBusinessConfig, shopSuppliesLabel } from '@/apps/settings/db'
import { buildRetailPayload, decideSendRecipient, RetailTotalMismatchError, type RetailWorkService, type RetailPayload } from './retail-invoice'
import { serviceDescription, extractPsid } from './retail-format'
import { loadRetailItemIndex } from './retail-item-map'
import { resolveRetailCustomer, resolveRetailCustomerIdentity } from './retail-customer'
import { resolveRetailItems, createRetailInvoiceInQB, findRetailInvoiceByPsid, getRetailInvoice, getRetailInvoiceRaw, updateRetailInvoiceInQB, fillRetailInvoiceEmail, sendRetailInvoiceInQB } from './retail-invoice-write'
import { QBApiError } from './errors'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:retail-invoice-service'

export interface CreateRetailResult {
  ok: boolean
  status: 'created' | 'creating' | 'error' | 'refused'
  invoiceId?: string | null
  invoiceNumber?: string | null
  totalCents?: number
  matchedBy?: string
  adopted?: boolean
  alreadyExisted?: boolean
  error?: string
}

const safeErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

async function jobContact(orderId: string, fallbackName: string) {
  const [row] = await getDb().select({ name: quickEntryJobs.customerName, email: quickEntryJobs.customerEmail, phone: quickEntryJobs.customerPhone })
    .from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, orderId)).orderBy(desc(quickEntryJobs.createdAt)).limit(1)
  return { name: (row?.name || fallbackName || 'Customer').trim(), email: row?.email ?? null, phone: row?.phone ?? null }
}

/**
 * Build the retail QB payload (work lines + fee lines + memo + PSID) from the AUTHORITATIVE
 * Invoice Draft. Shared by CREATE and SYNC so both produce byte-identical structure and the
 * same Σlines === draft total invariant (buildRetailPayload throws on mismatch). Pure of QB
 * customer resolution — the caller owns the CustomerRef. One QB line per real service using
 * the mapped Product/Service (catalog qb_item_ref) or the generic Labor fallback; Description
 * is the managed canonical qb_description (never AI-generated).
 */
async function buildRetailWorkPayload(params: {
  estimateId: string; order: OrderWithContext; full: FullEstimate | null; draft: InvoiceDraft
}): Promise<{ payload: RetailPayload; fallbacks: string[] }> {
  const { estimateId, order, full, draft } = params
  const items = await resolveRetailItems()
  const index = await loadRetailItemIndex()
  const userServices = (full?.services ?? []).filter((s) => s.source !== 'system')
  const fallbacks: string[] = []
  let workServices: RetailWorkService[] = userServices
    .map((s) => {
      const l = s.lines.find((x) => !x.generated); if (!l) return null
      const m = index.match(s.title)
      if (!m.usable) fallbacks.push(`${s.title}→Labor`)
      return { itemId: m.usable ? m.itemRef! : items.labor, description: serviceDescription(s.title, m.description), amountCents: lineAmountCents(l.priceCents, l.qty) }
    })
    .filter((x): x is RetailWorkService => !!x)
  // Safety net: an itemized Job with no priced service lines → one generic Labor line.
  if (workServices.length === 0) {
    workServices = [{ itemId: items.labor, description: (draft.services ?? []).join(', ') || 'Detailing services', amountCents: draft.workPriceCents }]
  }
  const v = order.vehicle
  const vehicle = { year: v.year, make: v.make, model: v.model, vin: v.vin, licensePlate: v.licensePlate }
  const payload = buildRetailPayload({
    estimateId, vehicle, workServices, feesItemId: items.fees,
    shopSuppliesCents: draft.shopSupplies.cents, paymentChargeCents: draft.paymentCharge.cents,
    paymentLabel: draft.paymentCharge.label, shopSuppliesLabel: await shopSuppliesLabel(),
    expectedTotalCents: draft.totalCents,
  })
  return { payload, fallbacks }
}

export async function createRetailQBInvoice(params: { orderId: string; actor: string | null; requestId?: string | null }): Promise<CreateRetailResult> {
  const { orderId, actor } = params
  const requestId = params.requestId ?? null
  const db = getDb()

  const est0 = await getEstimateRow(orderId)
  if (!est0) return { ok: false, status: 'refused', error: 'No estimate for this Job.' }
  // (1) Local guard — already created.
  if (est0.qbInvoiceId) {
    return { ok: true, status: 'created', invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, alreadyExisted: true }
  }

  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, status: 'refused', error: 'Job not found.' }
  if (isDealerOrder(order)) return { ok: false, status: 'refused', error: 'Dealer Jobs are invoiced through Dealer Check-In.' }

  const [full, cfg] = await Promise.all([getFullEstimate(orderId), getBusinessConfig()])
  const draft = buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'admin' })
  if (!draft.priced) return { ok: false, status: 'refused', error: 'Add a Work Price before invoicing.' }

  // (2) Compare-and-set lock — only one creator proceeds.
  const locked = await db.update(jobEstimates)
    .set({ qbStatus: 'creating', qbLastRequestId: requestId, updatedAt: new Date() })
    .where(and(eq(jobEstimates.id, est0.id), isNull(jobEstimates.qbInvoiceId), inArray(jobEstimates.qbStatus, ['none', 'error'])))
    .returning({ id: jobEstimates.id })
  if (locked.length === 0) {
    const fresh = await getEstimateRow(orderId)
    if (fresh?.qbInvoiceId) return { ok: true, status: 'created', invoiceId: fresh.qbInvoiceId, invoiceNumber: fresh.qbInvoiceNumber, alreadyExisted: true }
    return { ok: false, status: 'creating', error: 'A QuickBooks invoice is already being created for this Job.' }
  }

  const markError = async (msg: string, patch: Record<string, unknown> = {}) => {
    await db.update(jobEstimates).set({ qbStatus: 'error', qbSyncError: msg, updatedAt: new Date(), ...patch }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_error', employeeName: actor, note: msg }).catch(() => {})
  }

  try {
    // Retail needs per-service prices for separate QB lines. If the Job is flat, itemize it
    // now — REUSING the simplified-Estimate proportional allocation, which preserves the
    // Work Total exactly (explicit_pretax → itemized). Already-itemized Jobs are unchanged.
    let fullNow = full
    let draftNow = draft
    if (est0.priceMode === 'explicit_pretax') {
      await itemizeEstimate(est0.id, actor)
      fullNow = await getFullEstimate(orderId)
      draftNow = buildInvoiceDraft({ order, full: fullNow, paymentLabel: cfg.paymentLabel, role: 'admin' })
    }

    // One line per actual service (mapped Product/Service or Labor fallback) + fee lines.
    // Shared with Sync so both build identical structure and enforce Σlines == draft total.
    const { payload, fallbacks } = await buildRetailWorkPayload({ estimateId: est0.id, order, full: fullNow, draft: draftNow })
    const draft2 = draftNow

    // Resolve + cache the QB customer (with email reconciliation policy).
    const contact = await jobContact(orderId, draft2.customer ?? '')
    const customer = await resolveRetailCustomer(contact)

    // (3) PSID adoption — never duplicate a create that already succeeded in QB.
    const adopted = await findRetailInvoiceByPsid(customer.qbCustomerId, est0.id)
    if (adopted) {
      const hash = contentHash(customer.qbCustomerId, payload)
      await db.update(jobEstimates).set({
        qbInvoiceId: adopted.invoiceId, qbInvoiceNumber: adopted.invoiceNumber, qbSyncToken: adopted.syncToken,
        qbStatus: 'created', qbContentHash: hash, qbSyncedAt: new Date(), qbSyncError: null, updatedAt: new Date(),
      }).where(eq(jobEstimates.id, est0.id))
      await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_created', employeeName: actor, note: `adopted #${adopted.invoiceNumber} (${adopted.invoiceId})` })
      return { ok: true, status: 'created', invoiceId: adopted.invoiceId, invoiceNumber: adopted.invoiceNumber, totalCents: draft2.totalCents, matchedBy: customer.matchedBy, adopted: true }
    }

    // Create — per-service lines already carry resolved item ids; add customer-facing memo
    // (vehicle) + BillEmail. PSID stays internal in PrivateNote.
    const inv = await createRetailInvoiceInQB({
      customerId: customer.qbCustomerId, lines: payload.lines, privateNote: payload.privateNote,
      customerMemo: payload.customerMemo, billEmail: customer.billEmail,
    })

    // Post-write invariant — QB TotalAmt must equal the Pitt Stop draft total exactly.
    if (inv.totalAmtCents !== draft2.totalCents) {
      const msg = `QuickBooks TotalAmt ${inv.totalAmtCents}¢ != Pitt Stop total ${draft2.totalCents}¢`
      await markError(msg, { qbInvoiceId: inv.invoiceId, qbInvoiceNumber: inv.invoiceNumber, qbSyncToken: inv.syncToken })
      logger.error(APP, 'total_mismatch', { orderId, invoiceId: inv.invoiceId, qb: inv.totalAmtCents, draft: draft2.totalCents })
      return { ok: false, status: 'error', invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, error: msg }
    }

    const hash = contentHash(customer.qbCustomerId, payload)
    await db.update(jobEstimates).set({
      qbInvoiceId: inv.invoiceId, qbInvoiceNumber: inv.invoiceNumber, qbSyncToken: inv.syncToken,
      qbStatus: 'created', qbContentHash: hash, qbSyncedAt: new Date(), qbLastRequestId: requestId,
      qbSyncError: null, updatedAt: new Date(),
    }).where(eq(jobEstimates.id, est0.id))
    const emailNote = customer.emailConflict ? ' · EMAIL CONFLICT (review before Send)' : (customer.billEmail ? '' : ' · no email (Send blocked)')
    const itemNote = fallbacks.length ? ` · Labor fallback: ${fallbacks.join(', ')}` : ''
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_created', employeeName: actor, note: `#${inv.invoiceNumber} (${inv.invoiceId}) total $${(draft2.totalCents / 100).toFixed(2)} · ${customer.matchedBy}${customer.created ? '+created' : ''}${emailNote}${itemNote}` })
    logger.info(APP, 'created', { orderId, invoiceId: inv.invoiceId, number: inv.invoiceNumber, total: draft2.totalCents, emailStatus: customer.emailStatus, fallbacks })
    return { ok: true, status: 'created', invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, totalCents: draft2.totalCents, matchedBy: customer.matchedBy }
  } catch (err) {
    const msg = err instanceof RetailTotalMismatchError ? err.message : safeErr(err)
    await markError(msg)
    logger.error(APP, 'create_failed', { orderId, error: msg })
    return { ok: false, status: 'error', error: msg }
  }
}

function contentHash(customerId: string, payload: { lines: unknown; totalCents: number }): string {
  return crypto.createHash('sha256').update(JSON.stringify({ customerId, lines: payload.lines, total: payload.totalCents })).digest('hex')
}

// ── P-D3.2 retail Send (admin-only) ──────────────────────────────────────────
export type SendBlock = 'no_invoice' | 'not_priced' | 'dealer' | 'total_mismatch' | 'email_required' | 'email_conflict' | 'qb_read_failed' | 'send_failed'
export interface RetailSendResolution {
  ok: boolean
  block?: SendBlock
  invoiceId?: string | null
  invoiceNumber?: string | null
  recipient?: string | null
  needsFill?: boolean
  syncToken?: string | null
  qbTotalCents?: number
  draftTotalCents?: number
  emailStatus?: string
  alreadySent?: boolean
  error?: string
}

/**
 * READ-ONLY pre-send resolution: confirms the linked invoice exists, its TotalAmt still
 * equals the authoritative draft total, and the recipient email — WITHOUT sending or
 * mutating anything. Used for the Admin confirmation dialog AND re-checked inside send.
 */
export async function resolveRetailSend(orderId: string): Promise<RetailSendResolution> {
  const est = await getEstimateRow(orderId)
  if (!est || !est.qbInvoiceId) return { ok: false, block: 'no_invoice' }
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, block: 'no_invoice' }
  if (isDealerOrder(order)) return { ok: false, block: 'dealer' }
  const [full, cfg] = await Promise.all([getFullEstimate(orderId), getBusinessConfig()])
  const draft = buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'admin' })
  if (!draft.priced) return { ok: false, block: 'not_priced' }

  const inv = await getRetailInvoice(est.qbInvoiceId).catch(() => null)
  if (!inv) return { ok: false, block: 'qb_read_failed', invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber }

  // Total integrity — QB must still equal the authoritative Pitt Stop total.
  if (inv.totalAmtCents !== draft.totalCents) {
    return { ok: false, block: 'total_mismatch', invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, qbTotalCents: inv.totalAmtCents, draftTotalCents: draft.totalCents }
  }

  // Email resolution: invoice BillEmail → fill from PS email if blank → else block. Conflict
  // (invoice email present but differs from PS email) is surfaced, never silently overwritten.
  const contact = await jobContact(orderId, draft.customer ?? '')
  const common = { invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, syncToken: inv.syncToken, qbTotalCents: inv.totalAmtCents, draftTotalCents: draft.totalCents, emailStatus: inv.emailStatus, alreadySent: est.qbStatus === 'sent' || inv.emailStatus === 'EmailSent' }
  const d = decideSendRecipient(inv.billEmail, contact.email)
  if (!d.ok) return { ok: false, block: d.block, recipient: d.recipient ?? null, ...common }
  return { ok: true, recipient: d.recipient, needsFill: d.needsFill, ...common }
}

/** Send the EXACT linked invoice to the customer. Admin-only (enforced at the route).
 *  Never creates/clones/alters the invoice; retries target the same qb_invoice_id. */
export async function sendRetailQBInvoice(params: { orderId: string; actor: string | null }): Promise<RetailSendResolution> {
  const { orderId, actor } = params
  const db = getDb()
  const r = await resolveRetailSend(orderId)
  if (!r.ok) return r   // blocked (no_invoice / total_mismatch / email_required / email_conflict / …)

  try {
    if (r.needsFill && r.invoiceId && r.syncToken && r.recipient) {
      await fillRetailInvoiceEmail(r.invoiceId, r.syncToken, r.recipient)   // fills ONLY BillEmail
    }
    const sent = await sendRetailInvoiceInQB(r.invoiceId!, r.recipient)
    await db.update(jobEstimates).set({
      qbStatus: 'sent', qbSentAt: new Date(), qbSyncToken: sent.syncToken, qbSyncedAt: new Date(), qbSyncError: null, updatedAt: new Date(),
    }).where(eq(jobEstimates.serviceOrderId, orderId))
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_sent', employeeName: actor, note: `#${sent.invoiceNumber} (${r.invoiceId}) → ${r.recipient} · ${sent.emailStatus}` })
    logger.info(APP, 'sent', { orderId, invoiceId: r.invoiceId, recipient: r.recipient, emailStatus: sent.emailStatus })
    return { ok: true, invoiceId: r.invoiceId, invoiceNumber: sent.invoiceNumber, recipient: r.recipient, emailStatus: sent.emailStatus }
  } catch (err) {
    const msg = safeErr(err)
    // Preserve the created invoice linkage; record a safe send error; allow retry.
    await db.update(jobEstimates).set({ qbSyncError: msg, updatedAt: new Date() }).where(eq(jobEstimates.serviceOrderId, orderId))
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_send_failed', employeeName: actor, note: `#${r.invoiceNumber} (${r.invoiceId}) → ${r.recipient}: ${msg}` })
    logger.error(APP, 'send_failed', { orderId, invoiceId: r.invoiceId, error: msg })
    return { ok: false, block: 'send_failed', error: msg, invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, recipient: r.recipient }
  }
}

// ── P-D3.3 retail SYNC (Phase C) — UPDATE the linked invoice in place ─────────
export type SyncBlock =
  | 'no_invoice' | 'dealer' | 'not_priced' | 'invoice_missing' | 'identity_mismatch'
  | 'customer_mismatch' | 'confirm_required' | 'syncing' | 'total_mismatch' | 'sync_failed'
export interface RetailSyncResolution {
  ok: boolean
  block?: SyncBlock
  needsReview?: boolean
  invoiceId?: string | null
  invoiceNumber?: string | null
  alreadySent?: boolean
  noop?: boolean
  qbTotalCents?: number
  draftTotalCents?: number
  reviewReason?: string
  error?: string
}

class NeedsReviewError extends Error {
  constructor(public block: SyncBlock, message: string) { super(message); this.name = 'NeedsReviewError' }
}

/**
 * READ-ONLY pre-sync resolution. Confirms: a linked invoice exists; it's readable in QB; its
 * PSID identity matches (never sync a foreign/wrong invoice); the current customer still
 * resolves to the SAME QB customer (no auto-repoint); and whether it was already emailed. No
 * writes, no itemization. Powers the confirm dialog and is re-checked inside sync.
 */
export async function resolveRetailSync(orderId: string): Promise<RetailSyncResolution> {
  const est = await getEstimateRow(orderId)
  if (!est || !est.qbInvoiceId) return { ok: false, block: 'no_invoice' }
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, block: 'no_invoice' }
  if (isDealerOrder(order)) return { ok: false, block: 'dealer' }
  const [full, cfg] = await Promise.all([getFullEstimate(orderId), getBusinessConfig()])
  const draft = buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'admin' })
  const common = { invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber, draftTotalCents: draft.totalCents }
  if (!draft.priced) return { ok: false, block: 'not_priced', ...common }

  const raw = await getRetailInvoiceRaw(est.qbInvoiceId).catch(() => null)
  if (!raw) return { ok: false, block: 'invoice_missing', needsReview: true, reviewReason: 'Invoice missing in QuickBooks', ...common }
  if (String(raw.Id) !== String(est.qbInvoiceId) || extractPsid(raw.PrivateNote) !== est.id)
    return { ok: false, block: 'identity_mismatch', needsReview: true, reviewReason: 'Invoice identity / PSID does not match', ...common }

  const contact = await jobContact(orderId, draft.customer ?? '')
  const ident = await resolveRetailCustomerIdentity({ name: contact.name, email: contact.email, phone: contact.phone })
  if (!ident.qbCustomerId || String(ident.qbCustomerId) !== String(raw.CustomerRef?.value ?? ''))
    return { ok: false, block: 'customer_mismatch', needsReview: true, reviewReason: 'Customer no longer matches this invoice — review before syncing', ...common }

  const qbTotalCents = Math.round((raw.TotalAmt ?? 0) * 100)
  const alreadySent = est.qbStatus === 'sent' || raw.EmailStatus === 'EmailSent'
  return { ok: true, alreadySent, qbTotalCents, ...common }
}

/**
 * Sync the linked invoice IN PLACE from the current Invoice Draft (Phase C). Manager/admin
 * (route-enforced). Reuses the exact Create payload builder + total invariant. Never creates a
 * second invoice, never sends, never repoints/renames/creates a QB customer. Idempotent: a
 * no-op when nothing changed; a stale SyncToken (409) re-fetches, re-verifies PSID, retries.
 */
export async function syncRetailQBInvoice(params: { orderId: string; actor: string | null; confirmSent?: boolean }): Promise<RetailSyncResolution> {
  const { orderId, actor } = params
  const db = getDb()

  const pre = await resolveRetailSync(orderId)
  if (!pre.ok) {
    if (pre.needsReview) {
      await db.update(jobEstimates).set({ qbSyncError: `Needs review — ${pre.reviewReason}`, updatedAt: new Date() }).where(eq(jobEstimates.serviceOrderId, orderId)).catch(() => {})
      await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_sync_review', employeeName: actor, note: `${pre.block}: ${pre.reviewReason}` }).catch(() => {})
    }
    return pre
  }
  // Already-sent invoices require an explicit confirm before we change what the customer got.
  if (pre.alreadySent && !params.confirmSent) return { ...pre, ok: false, block: 'confirm_required', alreadySent: true }

  const est0 = await getEstimateRow(orderId)
  if (!est0 || !est0.qbInvoiceId) return { ok: false, block: 'no_invoice' }
  const wasSent = !!pre.alreadySent
  const restore = wasSent ? 'sent' : 'created'

  // Lock: one syncer at a time; only from a settled state (blocks double-tap / concurrent).
  const locked = await db.update(jobEstimates)
    .set({ qbStatus: 'syncing', updatedAt: new Date() })
    .where(and(eq(jobEstimates.id, est0.id), inArray(jobEstimates.qbStatus, ['created', 'sent', 'error'])))
    .returning({ id: jobEstimates.id })
  if (locked.length === 0) return { ok: false, block: 'syncing', invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, error: 'A sync is already in progress for this Job.' }

  const markError = async (evt: 'qb_invoice_sync_failed' | 'qb_invoice_sync_review', msg: string, status: string) => {
    await db.update(jobEstimates).set({ qbStatus: status, qbSyncError: msg, updatedAt: new Date() }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: evt, employeeName: actor, note: msg }).catch(() => {})
  }

  try {
    const order = await getOrderWithContext(orderId)
    if (!order) throw new Error('Job not found')
    const cfg = await getBusinessConfig()
    let fullNow = await getFullEstimate(orderId)
    let draftNow = buildInvoiceDraft({ order, full: fullNow, paymentLabel: cfg.paymentLabel, role: 'admin' })
    // Flat Jobs → itemize (reuses Create's exact-penny allocation; preserves the Work Total).
    if (est0.priceMode === 'explicit_pretax') {
      await itemizeEstimate(est0.id, actor)
      fullNow = await getFullEstimate(orderId)
      draftNow = buildInvoiceDraft({ order, full: fullNow, paymentLabel: cfg.paymentLabel, role: 'admin' })
    }
    const { payload } = await buildRetailWorkPayload({ estimateId: est0.id, order, full: fullNow, draft: draftNow })
    const contact = await jobContact(orderId, draftNow.customer ?? '')

    // Fetch → verify PSID identity → update. Re-fetch inside so a retry uses a fresh SyncToken.
    const attempt = async () => {
      const raw = await getRetailInvoiceRaw(est0.qbInvoiceId!)
      if (!raw) throw new NeedsReviewError('invoice_missing', 'Invoice missing in QuickBooks')
      if (String(raw.Id) !== String(est0.qbInvoiceId) || extractPsid(raw.PrivateNote) !== est0.id) throw new NeedsReviewError('identity_mismatch', 'Invoice identity / PSID mismatch')
      const customerId = String(raw.CustomerRef?.value ?? '')
      const newHash = contentHash(customerId, payload)
      const qbTotal = Math.round((raw.TotalAmt ?? 0) * 100)
      // No-op: content identical AND QB total already equals the draft → clear the flag only.
      if (newHash === est0.qbContentHash && qbTotal === draftNow.totalCents) {
        return { noop: true as const, written: { invoiceId: raw.Id, invoiceNumber: raw.DocNumber ?? null, syncToken: raw.SyncToken, totalAmtCents: qbTotal, lineCount: 0 }, newHash }
      }
      const billEmail = contact.email && contact.email.trim() ? contact.email.trim() : (raw.BillEmail?.Address ?? null)
      const written = await updateRetailInvoiceInQB({ current: raw, lines: payload.lines, privateNote: payload.privateNote, customerMemo: payload.customerMemo, billEmail })
      return { noop: false as const, written, newHash }
    }

    let res
    try { res = await attempt() }
    catch (e) { if (e instanceof QBApiError && e.status === 409) res = await attempt(); else throw e }

    // Post-write invariant: QB TotalAmt must equal the authoritative draft total exactly.
    if (!res.noop && res.written.totalAmtCents !== draftNow.totalCents) {
      const msg = `QuickBooks TotalAmt ${res.written.totalAmtCents}¢ != Pitt Stop total ${draftNow.totalCents}¢`
      await markError('qb_invoice_sync_failed', msg, 'error')
      return { ok: false, block: 'total_mismatch', invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, qbTotalCents: res.written.totalAmtCents, draftTotalCents: draftNow.totalCents, error: msg }
    }

    await db.update(jobEstimates).set({
      qbSyncToken: res.written.syncToken, qbContentHash: res.newHash, qbStatus: restore,
      qbSyncedAt: new Date(), qbSyncError: null, updatedAt: new Date(),
    }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_synced', employeeName: actor, note: `#${est0.qbInvoiceNumber} (${est0.qbInvoiceId}) ${res.noop ? 'no-op (already current)' : `updated · total $${(draftNow.totalCents / 100).toFixed(2)}`}${wasSent ? ' · after send' : ''}` })
    if (wasSent && !res.noop) await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_synced_after_send', employeeName: actor, note: `#${est0.qbInvoiceNumber} updated after it was emailed — customer may hold an older copy` }).catch(() => {})
    logger.info(APP, 'synced', { orderId, invoiceId: est0.qbInvoiceId, noop: res.noop, wasSent })
    return { ok: true, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, alreadySent: wasSent, noop: res.noop, draftTotalCents: draftNow.totalCents }
  } catch (err) {
    if (err instanceof NeedsReviewError) {
      await markError('qb_invoice_sync_review', `Needs review — ${err.message}`, restore)
      return { ok: false, block: err.block, needsReview: true, reviewReason: err.message, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber }
    }
    const msg = err instanceof RetailTotalMismatchError ? err.message : safeErr(err)
    await markError('qb_invoice_sync_failed', msg, 'error')
    logger.error(APP, 'sync_failed', { orderId, error: msg })
    return { ok: false, block: 'sync_failed', error: msg, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber }
  }
}

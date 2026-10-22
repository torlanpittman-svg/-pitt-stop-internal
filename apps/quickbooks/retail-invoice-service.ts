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
import { and, eq, isNull, isNotNull, inArray, desc, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { jobEstimates, serviceOrders, retailInvoiceMembers } from '@/apps/workflow/schema'
import { customers } from '@/apps/directory/schema'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { chooseInvoiceParty, type InvoiceParty } from './invoice-party'
import { getOrderWithContext, logEvent, type OrderWithContext } from '@/apps/workflow/db'
import { getEstimateRow, getFullEstimate, type FullEstimate, type EstimateRow } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft, type InvoiceDraft } from '@/apps/workflow/invoice-draft'
import { loadEstimateReview } from '@/apps/workflow/estimate-review'
import { SYNC_BLOCKING } from '@/apps/workflow/estimate-readiness'
import { isDealerOrder } from '@/apps/workflow/fees'
import { lineAmountCents } from '@/apps/workflow/estimate'
import { getBusinessConfig, shopSuppliesLabel } from '@/apps/settings/db'
import { buildRetailPayload, decideSendRecipient, RetailTotalMismatchError, type RetailWorkService, type RetailPayload, type RetailBuiltLine } from './retail-invoice'
import { serviceDescription, extractPsid, composeLineDescription, partLineDescription } from './retail-format'
import { loadRetailItemIndex } from './retail-item-map'
import { resolveRetailCustomer, resolveRetailCustomerIdentity, findRetailCustomerCandidates, persistRetailCustomerChoice, AmbiguousCustomerError, type QbCustomerCandidate } from './retail-customer'
import { resolveRetailItems, createRetailInvoiceInQB, findRetailInvoiceByPsid, getRetailInvoiceRaw, updateRetailInvoiceInQB, fillRetailInvoiceEmail, sendRetailInvoiceInQB, type RawQBInvoice } from './retail-invoice-write'
import { QBApiError } from './errors'
import { paymentLocksInvoice, isAmbiguousWriteError } from './retail-payment'
import { acquireRetailSyncLock, invoiceFreeOfPayments, type PaymentLockOwner } from './invoice-locks'
import { combineSharedPayload, linesFromRawInvoice, linesFromPayload, linesFingerprint, invoiceMoneyState, overwriteUnsafeLineTypes, type SharedSegment } from './shared-invoice-plan'
import { listActiveMembers, type MemberRow } from './shared-invoice-db'
import { logger } from '@/platform/logger'

const APP = 'quickbooks:retail-invoice-service'

export interface CreateRetailResult {
  ok: boolean
  status: 'created' | 'creating' | 'error' | 'refused' | 'ambiguous'
  invoiceId?: string | null
  invoiceNumber?: string | null
  totalCents?: number
  matchedBy?: string
  adopted?: boolean
  alreadyExisted?: boolean
  error?: string
  /** On status 'ambiguous': the colliding QB customers for the manager to choose from. */
  candidates?: QbCustomerCandidate[]
}

const safeErr = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/**
 * Who this order's QB invoice is BILLED to and SENT to. For ordinary jobs this is the service/job
 * contact (unchanged). For an occasional third-party-billed job (service_orders.billing_customer_id
 * set) it is the payer's directory identity, with the per-order recipient email steering BillEmail.
 * Shared by CREATE/SEND/SYNC so all three agree on the billed customer (no false "identity changed").
 */
async function invoiceParty(orderId: string, fallbackName: string): Promise<InvoiceParty> {
  const db = getDb()
  const [ord] = await db.select({ billingCustomerId: serviceOrders.billingCustomerId, recipient: serviceOrders.invoiceRecipientEmail })
    .from(serviceOrders).where(eq(serviceOrders.id, orderId)).limit(1)
  const [row] = await db.select({ name: quickEntryJobs.customerName, email: quickEntryJobs.customerEmail, phone: quickEntryJobs.customerPhone })
    .from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, orderId)).orderBy(desc(quickEntryJobs.createdAt)).limit(1)
  const serviceContact = { name: (row?.name || fallbackName || 'Customer').trim(), email: row?.email ?? null, phone: row?.phone ?? null }

  let billingCustomer: { displayName: string | null; email: string | null; phone: string | null } | null = null
  if (ord?.billingCustomerId) {
    const [c] = await db.select({ displayName: customers.displayName, email: customers.email, phone: customers.phone })
      .from(customers).where(eq(customers.id, ord.billingCustomerId)).limit(1)
    billingCustomer = c ?? null
  }
  return chooseInvoiceParty({ serviceContact, billingCustomer, recipientEmailOverride: ord?.recipient ?? null })
}

/** Back-compat shim: the billed-customer identity only (CREATE/SEND/SYNC identity + the picker). */
async function jobContact(orderId: string, fallbackName: string) {
  return (await invoiceParty(orderId, fallbackName)).contact
}
/** The billed-customer identity of a Job (shared-invoice discovery / link use the same identity as Create). */
export const retailInvoiceContact = jobContact

/**
 * Build the retail QB payload (work lines + fee lines + memo + PSID) from the AUTHORITATIVE
 * Invoice Draft. Shared by CREATE and SYNC so both produce byte-identical structure and the
 * same Σlines === draft total invariant (buildRetailPayload throws on mismatch). Pure of QB
 * customer resolution — the caller owns the CustomerRef. One QB line per real service using
 * the mapped Product/Service (catalog qb_item_ref) or the generic Labor fallback; Description
 * is the managed canonical qb_description (never AI-generated).
 */
export async function buildRetailWorkPayload(params: {
  estimateId: string; order: OrderWithContext; full: FullEstimate | null; draft: InvoiceDraft
}): Promise<{ payload: RetailPayload; fallbacks: string[] }> {
  const { estimateId, order, full, draft } = params
  const items = await resolveRetailItems()
  const index = await loadRetailItemIndex()
  const userServices = (full?.services ?? []).filter((s) => s.source !== 'system')
  const fallbacks: string[] = []
  const partsItem = index.partsItem()
  let workServices: RetailWorkService[] = userServices
    .map((s) => {
      const priced = s.lines.filter((x) => !x.generated); if (priced.length === 0) return null
      // ONE QB line per service. A service with several hand-entered lines bills their sum (the old
      // first-line-only read under-billed and then failed the Σlines === total invariant).
      const amountCents = priced.reduce((sum, l) => sum + lineAmountCents(l.priceCents, l.qty), 0)
      if (s.kind === 'part') {
        // Special-order part: the EXISTING general parts item (never created per part) + the real
        // part description / fitment / vendor part number captured on the line.
        const l = priced[0]
        const description = (l.description && l.description.trim()) || partLineDescription({ description: l.name, partNumber: l.partNumber })
        if (!partsItem) fallbacks.push(`${s.title}→Labor (no QuickBooks parts item)`)
        return { itemId: partsItem?.itemRef ?? items.labor, description, amountCents }
      }
      // Resolve the QB item by the service's STABLE catalog identity (falls back to label only for
      // legacy rows with no stamped identity) so a relabeled service keeps its item + description.
      const m = index.matchService({ catalogId: s.catalogId, title: s.title })
      if (!m.usable) fallbacks.push(`${s.title}→Labor`)
      // Description captured when the identity was chosen wins (later catalog edits apply to future
      // additions only); the job-specific detail is appended in the one approved format.
      const base = serviceDescription(s.title, (s.catalogId && s.catalogDescription) || m.description)
      return { itemId: m.usable ? m.itemRef! : items.labor, description: composeLineDescription(base, s.detail), amountCents }
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

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * A flat (explicit_pretax) Work Price is the agreed amount and the invoice bills exactly it, through the
 * same payload builder: per-service lines when every service already carries a price and those prices add
 * up to the agreed amount, otherwise (no service priced) the existing single Labor line at the agreed
 * amount. Any other state — service prices that add up to something else, or only some services priced —
 * needs a person to reconcile it in the Estimate, so this returns the refusal BEFORE any lock, estimate
 * change or QuickBooks call. Read-only: it never itemizes, splits or replaces the agreed amount.
 * (Flat → itemized no longer preserves the total — see itemizeFromFlat — so it must never run here.)
 */
export function flatPricingIssue(full: FullEstimate | null): string | null {
  const est = full?.estimate
  if (!full || !est || est.priceMode !== 'explicit_pretax' || est.explicitTotalCents == null) return null
  const agreed = est.explicitTotalCents
  const services = full.services.filter((s) => s.source !== 'system')
  const priced = services.filter((s) => s.lines.some((l) => !l.generated))
  if (priced.length === 0) return null
  const sum = priced.reduce((t, s) => t + s.lines.filter((l) => !l.generated).reduce((a, l) => a + lineAmountCents(l.priceCents, l.qty), 0), 0)
  if (priced.length === services.length && sum === agreed) return null
  if (priced.length < services.length) {
    return `The agreed Work Price is ${usd(agreed)}, but only ${priced.length} of ${services.length} services have their own price (${usd(sum)} so far). Open the Estimate and price every service to add up to ${usd(agreed)} (Set individual prices) before invoicing.`
  }
  return `The agreed Work Price is ${usd(agreed)}, but the service prices add up to ${usd(sum)}. Open the Estimate and reconcile them (Set individual prices) before invoicing — the agreed amount is never replaced automatically.`
}

// ── Shared retail invoice: one invoice, several retail Jobs (see shared-invoice.ts) ─────────────
/** One Job's authoritative Invoice Draft (the same read model Create / Sync use — no second calculation). */
export interface LoadedJob { orderId: string; order: OrderWithContext | null; full: FullEstimate | null; draft: InvoiceDraft | null }
export async function loadJobDraft(orderId: string): Promise<LoadedJob> {
  const order = await getOrderWithContext(orderId)
  if (!order) return { orderId, order: null, full: null, draft: null }
  const [full, cfg] = await Promise.all([getFullEstimate(orderId), getBusinessConfig()])
  return { orderId, order, full, draft: buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'admin' }) }
}

/**
 * Why this Job's charges can't be written onto an invoice yet — Create's exact gates (removed / estimate / dealer
 * / unpriced / partial or unaccepted itemizing / flat mismatch / unresolved estimate review). null = ready.
 */
export async function jobChargesIssue(j: LoadedJob): Promise<string | null> {
  const { order, full, draft } = j
  if (!order || !draft) return 'Job not found.'
  if (order.status === 'cancelled') return 'This Job was removed.'
  if (order.status === 'estimate') return 'Move the estimate to the Work Board first.'
  if (isDealerOrder(order)) return 'Dealer Jobs are invoiced through Dealer Check-In.'
  if (!draft.priced) return 'Add a Work Price first.'
  if (draft.pricingIncomplete) return 'Finish pricing every service first.'
  if (draft.referenceCents != null) return 'Accept the itemized total in the Estimate first.'
  const flat = flatPricingIssue(full)
  if (flat) return flat
  const review = await loadEstimateReview(order.id)
  if (!review.readiness.ready) return `Resolve in the Estimate first: ${review.readiness.summary}`
  return null
}

export type SharedMemberBlock = 'member_unready' | 'member_customer_mismatch'
/** A member Job can't be written onto the shared invoice — refused WITHOUT touching the anchor's invoice state. */
export class SharedMemberError extends Error {
  constructor(public block: SharedMemberBlock, public orderId: string, message: string) { super(message); this.name = 'SharedMemberError' }
}

/** A Job's line group on the invoice, with the vehicle it belongs to (for review screens and audit notes). */
export interface SharedPart { member: MemberRow | null; orderId: string; vehicle: string; totalCents: number; draft: InvoiceDraft }

/**
 * The invoice payload for the anchor Job plus the given member Jobs. With no members this is EXACTLY the
 * single-job payload (unchanged invoices never drift). Each Job's lines come from the per-job builder, which
 * enforces Σ its lines === its own draft total; combineSharedPayload re-asserts that and Σ all === Σ totals.
 */
export async function buildSharedInvoicePayload(params: { anchorEstimateId: string; anchor: LoadedJob; members: MemberRow[] }): Promise<{ payload: RetailPayload; legacyLines: RetailBuiltLine[]; fallbacks: string[]; parts: SharedPart[] }> {
  const { anchorEstimateId, anchor, members } = params
  if (!anchor.order || !anchor.draft) throw new Error('Job not found')
  const own = await buildRetailWorkPayload({ estimateId: anchorEstimateId, order: anchor.order, full: anchor.full, draft: anchor.draft })
  const parts: SharedPart[] = [{ member: null, orderId: anchor.orderId, vehicle: anchor.draft.vehicle, totalCents: anchor.draft.totalCents, draft: anchor.draft }]
  if (members.length === 0) return { payload: own.payload, legacyLines: own.payload.lines, fallbacks: own.fallbacks, parts }
  const v0 = anchor.order.vehicle
  const segments: SharedSegment[] = [{ estimateId: anchorEstimateId, totalCents: anchor.draft.totalCents, lines: own.payload.lines, vehicle: { year: v0.year, make: v0.make, model: v0.model, vin: v0.vin, licensePlate: v0.licensePlate } }]
  const fallbacks = [...own.fallbacks]
  for (const m of members) {
    const j = await loadJobDraft(m.memberServiceOrderId)
    const issue = await jobChargesIssue(j)
    if (issue) throw new SharedMemberError('member_unready', m.memberServiceOrderId, `${j.draft?.vehicle ?? 'A linked vehicle'}: ${issue}`)
    const built = await buildRetailWorkPayload({ estimateId: m.memberEstimateId, order: j.order!, full: j.full, draft: j.draft! })
    fallbacks.push(...built.fallbacks)
    const v = j.order!.vehicle
    segments.push({ estimateId: m.memberEstimateId, totalCents: j.draft!.totalCents, lines: built.payload.lines, vehicle: { year: v.year, make: v.make, model: v.model, vin: v.vin, licensePlate: v.licensePlate } })
    parts.push({ member: m, orderId: m.memberServiceOrderId, vehicle: j.draft!.vehicle, totalCents: j.draft!.totalCents, draft: j.draft! })
  }
  // The invoice is WRITTEN with the combined layout; `legacyLines` reconstructs the original per-vehicle layout
  // from the SAME segments so the tamper guards still accept invoices created before the combined layout existed.
  const payload = combineSharedPayload(anchorEstimateId, segments)
  const legacyLines = combineSharedPayload(anchorEstimateId, segments, { layout: 'legacy' }).lines
  return { payload, legacyLines, fallbacks, parts }
}

/** Does every included member Job still bill the invoice's QuickBooks customer? (read-only; first mismatch or null) */
export async function sharedMemberCustomerMismatch(members: MemberRow[], invoiceCustomerId: string): Promise<{ orderId: string; message: string } | null> {
  for (const m of members) {
    const order = await getOrderWithContext(m.memberServiceOrderId)
    const contact = await jobContact(m.memberServiceOrderId, order?.customerName ?? '')
    const ident = await resolveRetailCustomerIdentity({ name: contact.name, email: contact.email, phone: contact.phone })
    if (!ident.qbCustomerId || String(ident.qbCustomerId) !== String(invoiceCustomerId)) {
      return { orderId: m.memberServiceOrderId, message: `The customer on ${order ? [order.vehicle.year, order.vehicle.make, order.vehicle.model].filter(Boolean).join(' ') || 'a linked vehicle' : 'a linked vehicle'} no longer matches this invoice's QuickBooks customer — review it before updating.` }
    }
  }
  return null
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
  // A Job on a shared invoice never gets its own (the compare-and-set below refuses qb_status='linked' too).
  if (est0.qbStatus === 'linked') {
    const [m] = await db.select({ n: retailInvoiceMembers.qbInvoiceNumber }).from(retailInvoiceMembers)
      .where(and(eq(retailInvoiceMembers.memberEstimateId, est0.id), ne(retailInvoiceMembers.state, 'removed'))).limit(1)
    return { ok: false, status: 'refused', error: `This Job is billed on shared invoice${m?.n ? ` #${m.n}` : ''} — update that invoice instead of creating another.` }
  }

  const order = await getOrderWithContext(orderId)
  if (order?.status === 'estimate') return { ok: false, status: 'refused', error: 'Move this estimate to the Work Board before creating an invoice.' }
  if (!order) return { ok: false, status: 'refused', error: 'Job not found.' }
  if (isDealerOrder(order)) return { ok: false, status: 'refused', error: 'Dealer Jobs are invoiced through Dealer Check-In.' }

  const [full, cfg] = await Promise.all([getFullEstimate(orderId), getBusinessConfig()])
  const draft = buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'admin' })
  if (!draft.priced) return { ok: false, status: 'refused', error: 'Add a Work Price before invoicing.' }
  // Never invoice a partial itemized breakdown: some services are still unpriced, so the total is a
  // running sum, not the agreed amount. Finish pricing every service (or use a flat Work Price).
  if (draft.pricingIncomplete) return { ok: false, status: 'refused', error: 'Finish pricing every service (or set a flat Work Price) before invoicing.' }
  // Complete, but the itemized sum still differs from the agreed reference and the manager has not
  // accepted the new total yet — don't silently invoice a total that differs from what was agreed.
  if (draft.referenceCents != null) return { ok: false, status: 'refused', error: 'The itemized total differs from the agreed amount. Accept the itemized total in the Estimate before invoicing.' }
  const flatIssue = flatPricingIssue(full)
  if (flatIssue) return { ok: false, status: 'refused', error: flatIssue }
  // Parts labor review / unchosen odor or ambiguous-name services must be explicitly resolved
  // first (drafts still save freely; job completion is never gated by this).
  const review = await loadEstimateReview(orderId)
  if (!review.readiness.ready) return { ok: false, status: 'refused', error: `Resolve in the Estimate before invoicing: ${review.readiness.summary}` }

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
    // A flat Job is invoiced as-is (flatPricingIssue above guarantees its lines bill exactly the agreed
    // amount). It is never itemized here: itemizing no longer preserves the Work Total.
    const fullNow = full
    const draftNow = draft

    // One line per actual service (mapped Product/Service or Labor fallback) + fee lines.
    // Shared with Sync so both build identical structure and enforce Σlines == draft total.
    const { payload, fallbacks } = await buildRetailWorkPayload({ estimateId: est0.id, order, full: fullNow, draft: draftNow })
    const draft2 = draftNow

    // Resolve + cache the QB customer (with email reconciliation policy). For a third-party-billed
    // Job this resolves the PAYER (billing_customer_id); the per-order recipient steers BillEmail
    // ONLY (never written onto the payer's customer record). Ordinary Jobs are unchanged.
    const party = await invoiceParty(orderId, draft2.customer ?? '')
    const contact = party.contact
    const customer = await resolveRetailCustomer(contact)
    const billEmail = party.recipientEmail ?? customer.billEmail

    // (3) PSID adoption — never duplicate a create that already succeeded in QB.
    const adopted = await findRetailInvoiceByPsid(customer.qbCustomerId, est0.id)
    if (adopted) {
      const hash = contentHash(customer.qbCustomerId, payload, billEmail)
      await db.update(jobEstimates).set({
        qbInvoiceId: adopted.invoiceId, qbInvoiceNumber: adopted.invoiceNumber, qbSyncToken: adopted.syncToken,
        qbStatus: 'created', qbContentHash: hash, qbSyncedAt: new Date(), qbSyncError: null, qbLinesFingerprint: adopted.linesFingerprint, updatedAt: new Date(),
      }).where(eq(jobEstimates.id, est0.id))
      await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_created', employeeName: actor, note: `adopted #${adopted.invoiceNumber} (${adopted.invoiceId})` })
      return { ok: true, status: 'created', invoiceId: adopted.invoiceId, invoiceNumber: adopted.invoiceNumber, totalCents: draft2.totalCents, matchedBy: customer.matchedBy, adopted: true }
    }

    // Create — per-service lines already carry resolved item ids; add customer-facing memo
    // (vehicle) + BillEmail. PSID stays internal in PrivateNote.
    const inv = await createRetailInvoiceInQB({
      customerId: customer.qbCustomerId, lines: payload.lines, privateNote: payload.privateNote,
      customerMemo: payload.customerMemo, billEmail,
    })

    // Post-write invariant — QB TotalAmt must equal the Pitt Stop draft total exactly.
    if (inv.totalAmtCents !== draft2.totalCents) {
      const msg = `QuickBooks TotalAmt ${inv.totalAmtCents}¢ != Pitt Stop total ${draft2.totalCents}¢`
      await markError(msg, { qbInvoiceId: inv.invoiceId, qbInvoiceNumber: inv.invoiceNumber, qbSyncToken: inv.syncToken })
      logger.error(APP, 'total_mismatch', { orderId, invoiceId: inv.invoiceId, qb: inv.totalAmtCents, draft: draft2.totalCents })
      return { ok: false, status: 'error', invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, error: msg }
    }

    const hash = contentHash(customer.qbCustomerId, payload, billEmail)
    await db.update(jobEstimates).set({
      qbInvoiceId: inv.invoiceId, qbInvoiceNumber: inv.invoiceNumber, qbSyncToken: inv.syncToken,
      qbStatus: 'created', qbContentHash: hash, qbSyncedAt: new Date(), qbLastRequestId: requestId,
      qbSyncError: null, qbLinesFingerprint: inv.linesFingerprint, updatedAt: new Date(),
    }).where(eq(jobEstimates.id, est0.id))
    const emailNote = customer.emailConflict ? ' · EMAIL CONFLICT (review before Send)' : (billEmail ? '' : ' · no email (Send blocked)')
    const itemNote = fallbacks.length ? ` · Labor fallback: ${fallbacks.join(', ')}` : ''
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_created', employeeName: actor, note: `#${inv.invoiceNumber} (${inv.invoiceId}) total $${(draft2.totalCents / 100).toFixed(2)} · ${customer.matchedBy}${customer.created ? '+created' : ''}${emailNote}${itemNote}` })
    logger.info(APP, 'created', { orderId, invoiceId: inv.invoiceId, number: inv.invoiceNumber, total: draft2.totalCents, emailStatus: customer.emailStatus, fallbacks })
    return { ok: true, status: 'created', invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, totalCents: draft2.totalCents, matchedBy: customer.matchedBy }
  } catch (err) {
    const msg = err instanceof RetailTotalMismatchError ? err.message : safeErr(err)
    await markError(msg)
    // Ambiguous customer: fail closed as before, but hand the colliding QB customers back so a
    // manager can pick the right one (persisted to the directory cache) instead of hitting a
    // dead-end. No invoice was created.
    if (err instanceof AmbiguousCustomerError) {
      logger.warn(APP, 'create_ambiguous_customer', { orderId, candidates: err.candidates.length })
      return { ok: false, status: 'ambiguous', error: msg, candidates: err.candidates }
    }
    logger.error(APP, 'create_failed', { orderId, error: msg })
    return { ok: false, status: 'error', error: msg }
  }
}

// ── Manager QB-customer disambiguation (list candidates + persist the chosen mapping) ─────────
export interface RetailCustomerCandidatesResult {
  ok: boolean
  contact?: { name: string; email: string | null; phone: string | null }
  emailMatches?: QbCustomerCandidate[]
  nameMatches?: QbCustomerCandidate[]
  alreadyLinked?: boolean          // directory already caches a QB id for this contact
  hasInvoice?: boolean             // a QB invoice already exists (customer is locked to it)
  error?: string
}

/**
 * READ-ONLY: the QB customers this Job's retail contact matches, for the manager picker. Does not
 * create, pick, or write anything. Returns the candidate sets plus whether the contact is already
 * linked (directory cache) or the Job already has an invoice.
 */
export async function listRetailCustomerCandidates(orderId: string): Promise<RetailCustomerCandidatesResult> {
  const est = await getEstimateRow(orderId)
  if (!est) return { ok: false, error: 'No estimate for this Job.' }
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, error: 'Job not found.' }
  if (isDealerOrder(order)) return { ok: false, error: 'Dealer Jobs are invoiced through Dealer Check-In.' }
  const contact = await jobContact(orderId, order.customerName ?? '')
  const { emailMatches, nameMatches } = await findRetailCustomerCandidates(contact)
  const ident = await resolveRetailCustomerIdentity(contact).catch(() => ({ qbCustomerId: null, matchedBy: 'none' as const }))
  return {
    ok: true, contact, emailMatches, nameMatches,
    alreadyLinked: ident.matchedBy === 'directory-cache' && !!ident.qbCustomerId,
    hasInvoice: !!est.qbInvoiceId,
  }
}

export interface SetRetailCustomerResult {
  ok: boolean
  qbCustomerId?: string
  displayName?: string | null
  directoryCustomerId?: string | null
  error?: string
}

/**
 * Persist a MANAGER-CHOSEN QB CustomerRef for this Job's retail contact (directory cache), so the
 * next Create resolves via directory-cache (CASE 1) and the email/name ambiguity never blocks
 * invoicing again. Validates the id against QB; never creates/renames/merges a QB customer; refuses
 * once an invoice exists (the customer is then locked to that invoice). Append-only audit event.
 */
export async function setRetailCustomerChoice(params: { orderId: string; qbCustomerId: string; actor: string | null }): Promise<SetRetailCustomerResult> {
  const { orderId, actor } = params
  const qbCustomerId = (params.qbCustomerId ?? '').trim()
  if (!qbCustomerId) return { ok: false, error: 'Choose a QuickBooks customer.' }
  const est = await getEstimateRow(orderId)
  if (!est) return { ok: false, error: 'No estimate for this Job.' }
  if (est.qbInvoiceId) return { ok: false, error: 'This Job already has a QuickBooks invoice — the customer is locked to it.' }
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, error: 'Job not found.' }
  if (isDealerOrder(order)) return { ok: false, error: 'Dealer Jobs are invoiced through Dealer Check-In.' }
  const contact = await jobContact(orderId, order.customerName ?? '')
  try {
    const res = await persistRetailCustomerChoice(contact, qbCustomerId)
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_customer_mapped', employeeName: actor, note: `"${contact.name}" → QuickBooks customer ${res.displayName ?? '?'} (${res.qbCustomerId})` })
    // Clear the prior ambiguity error so the Create button no longer shows the dead-end message.
    if (est.qbStatus === 'error' && /resolve the QuickBooks customer/i.test(est.qbSyncError ?? '')) {
      await getDb().update(jobEstimates).set({ qbStatus: 'none', qbSyncError: null, updatedAt: new Date() }).where(eq(jobEstimates.id, est.id))
    }
    logger.info(APP, 'customer_mapped', { orderId, qbCustomerId: res.qbCustomerId })
    return { ok: true, qbCustomerId: res.qbCustomerId, displayName: res.displayName, directoryCustomerId: res.directoryCustomerId }
  } catch (err) {
    const msg = safeErr(err)
    logger.error(APP, 'customer_map_failed', { orderId, error: msg })
    return { ok: false, error: msg }
  }
}

// Drift fingerprint — MUST cover every field Sync can push, so a vehicle-only (CustomerMemo)
// or email-only (BillEmail) change is detected and not skipped as a no-op.
function contentHash(customerId: string, payload: { lines: RetailBuiltLine[]; totalCents: number; customerMemo?: string }, billEmail?: string | null): string {
  // Hash ONLY the wire fields of each line (kind/itemId/description/amountCents), never the internal `fee`
  // metadata. Keeping the projection's key order identical to how the lines are built means a single-job invoice
  // hashes byte-for-byte as it did before fee tagging existed — so existing invoices don't look "changed".
  const lines = payload.lines.map((l) => ({ itemId: l.itemId, description: l.description, amountCents: l.amountCents, kind: l.kind }))
  return crypto.createHash('sha256')
    .update(JSON.stringify({ customerId, lines, total: payload.totalCents, memo: payload.customerMemo ?? '', email: (billEmail ?? '').trim().toLowerCase() }))
    .digest('hex')
}

// ── P-D3.2 / Phase D retail Send (manager + admin) ────────────────────────────
export type SendBlock =
  | 'no_invoice' | 'not_priced' | 'dealer' | 'total_mismatch' | 'email_required' | 'email_conflict'
  | 'qb_read_failed' | 'invoice_missing' | 'identity_mismatch' | 'customer_mismatch'
  | 'sync_needed' | 'needs_review' | 'sending' | 'send_failed' | 'paid'
  | 'shared_pending' | 'shared_member_unready'
export interface RetailSendResolution {
  ok: boolean
  block?: SendBlock
  needsReview?: boolean
  invoiceId?: string | null
  invoiceNumber?: string | null
  recipient?: string | null
  needsFill?: boolean
  syncToken?: string | null
  qbTotalCents?: number
  draftTotalCents?: number
  emailStatus?: string
  alreadySent?: boolean
  reconciled?: boolean
  error?: string
}

/** A positively verified linked retail invoice (shared by Send, Record Payment and Email Paid Invoice). */
export interface VerifiedLinkedInvoice {
  ok: true
  est: EstimateRow
  raw: RawQBInvoice
  draft: InvoiceDraft
  full: FullEstimate | null
  contact: { name: string; email: string | null; phone: string | null }
  common: { invoiceId: string | null; invoiceNumber: string | null; syncToken: string; qbTotalCents: number; draftTotalCents: number; emailStatus: string; alreadySent: boolean }
  /** Other retail Jobs are on this invoice (draftTotalCents is then the combined total of every Job on it). */
  shared: boolean
}
export type LinkedInvoiceCheck = VerifiedLinkedInvoice | (RetailSendResolution & { ok: false })

/**
 * READ-ONLY verification of the linked invoice: PSID + invoice-id identity, the customer still
 * resolves to the SAME QB customer, and — unless `paidInvoice` — the Job is priced, not in a
 * needs_review / sync-needed state, and QB TotalAmt equals the authoritative draft total. NO writes.
 * `paidInvoice` (Email Paid Invoice): QuickBooks' paid invoice is the truth being emailed, so only
 * identity is re-checked there.
 * `allowDrift` (Record Payment resuming an interrupted Cash / Check card-fee removal): the local charge was
 * already removed and QuickBooks may or may not have been synced yet — identity, customer, pricing and review
 * are still enforced, but "sync needed" and the total comparison are left to the caller, which syncs and
 * re-verifies under its lock before any payment.
 */
export async function verifyLinkedRetailInvoice(orderId: string, opts: { paidInvoice?: boolean; allowDrift?: boolean } = {}): Promise<LinkedInvoiceCheck> {
  const est = await getEstimateRow(orderId)
  if (!est || !est.qbInvoiceId) return { ok: false, block: 'no_invoice' }
  const order = await getOrderWithContext(orderId)
  if (!order) return { ok: false, block: 'no_invoice' }
  if (isDealerOrder(order)) return { ok: false, block: 'dealer' }
  const [full, cfg] = await Promise.all([getFullEstimate(orderId), getBusinessConfig()])
  const draft = buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'admin' })
  const idBase = { invoiceId: est.qbInvoiceId, invoiceNumber: est.qbInvoiceNumber }
  if (!opts.paidInvoice) {
    // Combine unpaid invoices is voiding this invoice into another one — nothing may be sent or paid against it.
    if (est.qbStatus === 'consolidating') return { ok: false, block: 'shared_pending', ...idBase, error: 'This invoice is being combined into another invoice — finish or cancel the combine first.' }
    if (!draft.priced) return { ok: false, block: 'not_priced', ...idBase }
    // A Job in a needs_review / sync-needed state must be resolved first — never act on a stale
    // invoice (same-total edits are caught here, not only by total_mismatch).
    const err = est.qbSyncError ?? ''
    if (/^needs review/i.test(err)) return { ok: false, block: 'needs_review', needsReview: true, ...idBase }
    if (/sync needed/i.test(err) && !opts.allowDrift) return { ok: false, block: 'sync_needed', ...idBase }
  }

  const raw = await getRetailInvoiceRaw(est.qbInvoiceId).catch(() => null)
  if (!raw) return { ok: false, block: 'invoice_missing', needsReview: true, ...idBase }
  if (String(raw.Id) !== String(est.qbInvoiceId) || extractPsid(raw.PrivateNote) !== est.id)
    return { ok: false, block: 'identity_mismatch', needsReview: true, ...idBase }

  const contact = await jobContact(orderId, draft.customer ?? '')
  const ident = await resolveRetailCustomerIdentity({ name: contact.name, email: contact.email, phone: contact.phone })
  if (!ident.qbCustomerId || String(ident.qbCustomerId) !== String(raw.CustomerRef?.value ?? ''))
    return { ok: false, block: 'customer_mismatch', needsReview: true, ...idBase }

  // Shared invoice: the authoritative total is this Job's draft + every APPLIED member Job's draft. While a linked
  // Job's charges are still pending review, the invoice in QuickBooks is knowingly incomplete — Send and Record
  // Payment wait (no stale invoice goes out). Paid-invoice paths only re-check identity, as before.
  const members = await listActiveMembers(est.id)
  let draftTotalCents = draft.totalCents
  if (members.length && !opts.paidInvoice) {
    if (members.some((m) => m.state === 'pending')) return { ok: false, block: 'shared_pending', ...idBase, error: 'A linked vehicle’s charges are not on this invoice yet — review and update the shared invoice first.' }
    for (const m of members) {
      const j = await loadJobDraft(m.memberServiceOrderId)
      if (!j.draft?.priced || j.order?.status === 'cancelled') return { ok: false, block: 'shared_member_unready', ...idBase }
      draftTotalCents += j.draft.totalCents
    }
    const mismatch = await sharedMemberCustomerMismatch(members, String(raw.CustomerRef?.value ?? ''))
    if (mismatch) return { ok: false, block: 'customer_mismatch', needsReview: true, ...idBase, error: mismatch.message }
  }

  const qbTotalCents = Math.round((raw.TotalAmt ?? 0) * 100)
  const emailStatus = raw.EmailStatus ?? 'NotSet'
  const common = { ...idBase, syncToken: raw.SyncToken, qbTotalCents, draftTotalCents, emailStatus, alreadySent: est.qbStatus === 'sent' || emailStatus === 'EmailSent' }
  // Total integrity — QB must still equal the authoritative Pitt Stop total.
  if (!opts.paidInvoice && !opts.allowDrift && qbTotalCents !== draftTotalCents) return { ok: false, block: 'total_mismatch', ...common }
  return { ok: true, est, raw, draft, full, contact, common, shared: members.length > 0 }
}

/**
 * READ-ONLY pre-send resolution (Phase D hardened). Positively verifies the linked invoice
 * before we ever email (verifyLinkedRetailInvoice) — plus the recipient email. NO writes.
 * Re-checked inside send.
 */
export async function resolveRetailSend(orderId: string): Promise<RetailSendResolution> {
  const v = await verifyLinkedRetailInvoice(orderId)
  if (!v.ok) return v
  // Email resolution: invoice BillEmail → fill from PS email if blank → else block. Conflict
  // (invoice email present but differs from PS email) is surfaced, never silently overwritten.
  const d = decideSendRecipient(v.raw.BillEmail?.Address ?? null, v.contact.email)
  if (!d.ok) return { ok: false, block: d.block, recipient: d.recipient ?? null, ...v.common }
  return { ok: true, recipient: d.recipient, needsFill: d.needsFill, ...v.common }
}

/**
 * Send (or Resend) the EXACT linked invoice. Manager/admin (route-enforced). Never creates/
 * clones/alters the invoice. Duplicate-email safe:
 *   • already-sent + not an explicit resend → reconcile/adopt the sent state, DO NOT re-email
 *     (covers a lost response after QB actually sent);
 *   • compare-and-set qb_status='sending' lock serializes double-taps;
 *   • only resend=true intentionally emails an already-EmailSent invoice.
 */
export async function sendRetailQBInvoice(params: { orderId: string; actor: string | null; resend?: boolean }): Promise<RetailSendResolution> {
  const { orderId, actor } = params
  const resend = !!params.resend
  const db = getDb()
  // Once a payment is recorded / in flight / unconfirmed, emailing is Email Paid Invoice's job (its delivery
  // check relies on no other send moving Invoice.DeliveryInfo). Checked here AND in the lock below.
  const estPay = await getEstimateRow(orderId)
  if (estPay && paymentLocksInvoice({ status: estPay.qbPaymentStatus, balanceState: estPay.qbPaymentBalanceState })) {
    return { ok: false, block: 'paid', invoiceId: estPay.qbInvoiceId, invoiceNumber: estPay.qbInvoiceNumber, error: 'A payment is recorded on this invoice — use Email Paid Invoice instead.' }
  }
  const r = await resolveRetailSend(orderId)
  if (!r.ok) return r   // blocked (no_invoice / sync_needed / needs_review / total_mismatch / email_* / …)

  // Already sent and NOT an explicit resend → never email again; adopt the sent state if the
  // local write was lost after QB had emailed (ambiguous response / refresh).
  if (r.alreadySent && !resend) {
    const est = await getEstimateRow(orderId)
    if (est && est.qbStatus !== 'sent') {
      await db.update(jobEstimates).set({ qbStatus: 'sent', qbSentAt: est.qbSentAt ?? new Date(), qbSyncError: null, updatedAt: new Date() }).where(eq(jobEstimates.id, est.id))
      await logEvent({ serviceOrderId: orderId, eventType: 'invoice_send_reconciled', employeeName: actor, note: `#${r.invoiceNumber} (${r.invoiceId}) already EmailSent in QuickBooks — adopted sent state (no re-email)` }).catch(() => {})
    }
    return { ok: true, alreadySent: true, reconciled: est?.qbStatus !== 'sent', invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, recipient: r.recipient, emailStatus: r.emailStatus }
  }

  // Lock: one sender at a time (blocks double-tap / concurrent). Settled states only.
  const est0 = await getEstimateRow(orderId)
  if (!est0 || !est0.qbInvoiceId) return { ok: false, block: 'no_invoice' }
  const priorStatus = est0.qbStatus === 'sent' ? 'sent' : 'created'
  const locked = await db.update(jobEstimates)
    .set({ qbStatus: 'sending', updatedAt: new Date() })
    .where(and(eq(jobEstimates.id, est0.id), inArray(jobEstimates.qbStatus, ['created', 'sent', 'error']), invoiceFreeOfPayments()))
    .returning({ id: jobEstimates.id })
  if (locked.length === 0) return { ok: false, block: 'sending', invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, error: 'A send is already in progress for this Job.' }

  try {
    // A member Job can link to this invoice between the read-only precheck (resolveRetailSend) and this lock. A
    // pending member means the invoice in QuickBooks is knowingly incomplete, so never email a stale copy. Re-read
    // UNDER the lock and BEFORE any external write; if a member is now pending, release the lock and refuse — no
    // email fill, no send. (Link already refuses while the anchor is 'sending', so this closes the race both ways.)
    if ((await listActiveMembers(est0.id)).some((m) => m.state === 'pending')) {
      await db.update(jobEstimates).set({ qbStatus: priorStatus, updatedAt: new Date() }).where(eq(jobEstimates.id, est0.id))
      return { ok: false, block: 'shared_pending', invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, recipient: r.recipient, error: 'A linked vehicle’s charges are not on this invoice yet — update the shared invoice before sending.' }
    }

    if (r.needsFill && r.invoiceId && r.syncToken && r.recipient) {
      await fillRetailInvoiceEmail(r.invoiceId, r.syncToken, r.recipient)   // fills ONLY BillEmail
    }
    const sent = await sendRetailInvoiceInQB(r.invoiceId!, r.recipient)
    await db.update(jobEstimates).set({
      qbStatus: 'sent', qbSentAt: new Date(), qbSyncToken: sent.syncToken, qbSyncedAt: new Date(), qbSyncError: null, updatedAt: new Date(),
    }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: resend ? 'invoice_resend' : 'invoice_sent', employeeName: actor, note: `#${sent.invoiceNumber} (${r.invoiceId}) → ${r.recipient} · ${sent.emailStatus}${resend ? ' · RESEND' : ''}` })
    logger.info(APP, resend ? 'resent' : 'sent', { orderId, invoiceId: r.invoiceId, recipient: r.recipient, emailStatus: sent.emailStatus })
    return { ok: true, invoiceId: r.invoiceId, invoiceNumber: sent.invoiceNumber, recipient: r.recipient, emailStatus: sent.emailStatus }
  } catch (err) {
    const msg = safeErr(err)
    // Preserve the linkage; restore the prior settled status; record a safe error; allow retry.
    await db.update(jobEstimates).set({ qbStatus: priorStatus, qbSyncError: msg, updatedAt: new Date() }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: 'invoice_send_failed', employeeName: actor, note: `#${r.invoiceNumber} (${r.invoiceId}) → ${r.recipient}: ${msg}` })
    logger.error(APP, 'send_failed', { orderId, invoiceId: r.invoiceId, error: msg })
    return { ok: false, block: 'send_failed', error: msg, invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, recipient: r.recipient }
  }
}

// ── P-D3.3 retail SYNC (Phase C) — UPDATE the linked invoice in place ─────────
export type SyncBlock =
  | 'no_invoice' | 'dealer' | 'not_priced' | 'invoice_missing' | 'identity_mismatch'
  | 'customer_mismatch' | 'confirm_required' | 'syncing' | 'total_mismatch' | 'sync_failed' | 'estimate_review' | 'paid' | 'pricing'
  | 'stale' | 'lines_changed' | 'shared_pending' | SharedMemberBlock
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
  /** The QuickBooks update failed in a way that may still have applied (timeout / network / 5xx). */
  ambiguous?: boolean
  /** Shared invoice: member Jobs whose charges this update wrote onto the invoice for the first time. */
  appliedOrderIds?: string[]
  /** The member Job a shared-invoice refusal is about. */
  memberOrderId?: string
}

class NeedsReviewError extends Error {
  constructor(public block: SyncBlock, message: string) { super(message); this.name = 'NeedsReviewError' }
}
/** The invoice changed in QuickBooks after the manager reviewed it — nothing written; review again. */
class StaleReviewError extends Error {
  constructor() { super('The invoice changed in QuickBooks after you reviewed it. Nothing was updated — review it again.'); this.name = 'StaleReviewError' }
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
export async function syncRetailQBInvoice(params: {
  orderId: string; actor: string | null; confirmSent?: boolean; paymentLock?: PaymentLockOwner
  /** Shared invoice: also write the charges of linked Jobs still pending review (the reviewed "Update invoice"). */
  applyPending?: boolean
  /** Shared invoice: the QuickBooks SyncToken the manager reviewed — refuse if the invoice changed since. */
  expectedSyncToken?: string | null
}): Promise<RetailSyncResolution> {
  const { orderId, actor } = params
  const db = getDb()

  // A payment is recorded (or being recorded / not yet confirmed) against this invoice — never rewrite
  // its lines in place; a paid invoice is corrected in QuickBooks by a person. The one exception is Record
  // Payment itself (Cash / Check card-fee removal), syncing BEFORE it pays, under its own still-held lock.
  const estPay = await getEstimateRow(orderId)
  const ownsPaymentLock = !!params.paymentLock && estPay?.qbPaymentStatus === 'recording'
    && estPay.qbPaymentRequestId === params.paymentLock.requestId && estPay.qbPaymentStartedAt?.getTime() === params.paymentLock.startedAt.getTime()
  if (estPay && paymentLocksInvoice({ status: estPay.qbPaymentStatus, balanceState: estPay.qbPaymentBalanceState }) && !ownsPaymentLock) {
    return { ok: false, block: 'paid', invoiceId: estPay.qbInvoiceId, invoiceNumber: estPay.qbInvoiceNumber, error: 'A payment is recorded on this invoice — it can no longer be synced from Pitt Stop. Correct it in QuickBooks.' }
  }

  // Estimate review first (local, no QuickBooks call): an unresolved ceramic coating or parts-labor review
  // never reaches QuickBooks — not even a read.
  const syncIssues = (await loadEstimateReview(orderId)).readiness.issues.filter((i) => SYNC_BLOCKING.includes(i.code))
  if (syncIssues.length) return { ok: false, block: 'estimate_review', error: `Resolve in the Estimate before syncing: ${syncIssues.map((i) => i.message).join(' ')}` }
  const flatIssue = flatPricingIssue(await getFullEstimate(orderId))
  if (flatIssue) return { ok: false, block: 'pricing', error: flatIssue.replace('before invoicing', 'before syncing') }
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
  if (!(await acquireRetailSyncLock(est0.id, params.paymentLock))) return { ok: false, block: 'syncing', invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, error: 'A sync is already in progress for this Job.' }

  const markError = async (evt: 'qb_invoice_sync_failed' | 'qb_invoice_sync_review', msg: string, status: string) => {
    await db.update(jobEstimates).set({ qbStatus: status, qbSyncError: msg, updatedAt: new Date() }).where(eq(jobEstimates.id, est0.id))
    await logEvent({ serviceOrderId: orderId, eventType: evt, employeeName: actor, note: msg }).catch(() => {})
  }

  // Set once the QuickBooks update request is issued: a failure before that point cannot have changed the invoice.
  let updateIssued = false
  try {
    const order = await getOrderWithContext(orderId)
    if (!order) throw new Error('Job not found')
    const cfg = await getBusinessConfig()
    // Flat Jobs sync as-is (checked by flatPricingIssue before the lock) — never itemized here.
    const fullNow = await getFullEstimate(orderId)
    const draftNow = buildInvoiceDraft({ order, full: fullNow, paymentLabel: cfg.paymentLabel, role: 'admin' })
    // Shared invoice: read the members and this row AFTER taking the Sync lock — link / unlink serialize on that
    // lock, so this member set and the stored line fingerprint are final for this write. Pending members are
    // written only by a reviewed update (applyPending); otherwise only already-applied members are rebuilt.
    const estL = (await getEstimateRow(orderId)) ?? est0
    const active = await listActiveMembers(est0.id)
    const shared = active.length > 0
    // Ordinary Sync (NOT the reviewed "Update invoice") must never run while a member is still pending: it rebuilds
    // the invoice from the anchor + APPLIED members only, so if a reviewed update's QuickBooks write had LANDED but
    // its local finalization then failed (anchor now 'error', member still 'pending'), rebuilding without that member
    // here would STRIP the charges already on the invoice. Only applyPending (reviewed, under expectedSyncToken) may
    // change a shared invoice while a member is pending. Release the lock to the prior settled state and refuse.
    if (!params.applyPending && active.some((m) => m.state === 'pending')) {
      await db.update(jobEstimates).set({ qbStatus: est0.qbStatus, updatedAt: new Date() }).where(eq(jobEstimates.id, est0.id))
      return { ok: false, block: 'shared_pending', invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, error: 'A linked vehicle’s charges are pending review — update the shared invoice, or keep that vehicle separate, before syncing.' }
    }
    const included = active.filter((m) => m.state === 'applied' || (params.applyPending && m.state === 'pending'))
    // A member whose OWN invoice still exists (a Combine unpaid invoices that hasn't voided it yet) must never be
    // written here too — that would bill its charges on two invoices at once.
    const ownInvoice = included.length
      ? await db.select({ id: jobEstimates.serviceOrderId, n: jobEstimates.qbInvoiceNumber }).from(jobEstimates)
        .where(and(inArray(jobEstimates.id, included.map((m) => m.memberEstimateId)), isNotNull(jobEstimates.qbInvoiceId)))
      : []
    if (ownInvoice.length) throw new SharedMemberError('member_unready', ownInvoice[0].id, `A linked vehicle still has its own invoice #${ownInvoice[0].n ?? ''} — finish the combine first.`)
    const { payload, legacyLines, parts } = await buildSharedInvoicePayload({ anchorEstimateId: est0.id, anchor: { orderId, order, full: fullNow, draft: draftNow }, members: included })
    const targetCents = payload.totalCents
    const targetLinesFp = linesFingerprint(linesFromPayload(payload.lines))
    // Accept the legacy per-vehicle layout too: a shared invoice written before the combined layout still holds
    // those lines in QuickBooks, so this reconstruction lets Sync recognise it as Pitt Stop's (and rewrite it to
    // the combined layout) instead of refusing it as a QuickBooks-side edit. Any OTHER line set still fails closed.
    const legacyLinesFp = linesFingerprint(linesFromPayload(legacyLines))
    const contact = await jobContact(orderId, draftNow.customer ?? '')

    // Fetch → verify PSID identity → update. Re-fetch inside so a retry uses a fresh SyncToken.
    const attempt = async () => {
      const raw = await getRetailInvoiceRaw(est0.qbInvoiceId!)
      if (!raw) throw new NeedsReviewError('invoice_missing', 'Invoice missing in QuickBooks')
      if (String(raw.Id) !== String(est0.qbInvoiceId) || extractPsid(raw.PrivateNote) !== est0.id) throw new NeedsReviewError('identity_mismatch', 'Invoice identity / PSID mismatch')
      // Money applied in QuickBooks (paid online / entered there) that Pitt Stop hasn't read yet: never rewrite it.
      const liveTotal = Math.round((raw.TotalAmt ?? 0) * 100)
      if (raw.Balance != null && Math.round(raw.Balance * 100) < liveTotal) throw new NeedsReviewError('paid', 'QuickBooks shows a payment or credit applied to this invoice — correct it in QuickBooks, not by syncing')
      // Shared invoice: this write concatenates ANOTHER Job's charges onto the SAME invoice, so it must be
      // entirely untouched by money and hold only lines Pitt Stop can rebuild. The Balance<Total check above
      // misses a $0/voided invoice, a missing balance, and a Payment/Credit/Deposit linked at an EQUAL balance,
      // so rerun the full money state. And because the line fingerprint ignores SubTotal/Discount/Group/unknown
      // lines, a rewrite would silently drop them — refuse any line type we can't rebuild. Fail closed on both.
      if (shared) {
        const money = invoiceMoneyState(raw)
        if (!money.untouched) throw new NeedsReviewError('paid', `QuickBooks shows money activity on this invoice — ${money.reason ?? 'it is no longer untouched'} Correct it in QuickBooks, not by syncing.`)
        const unsafe = overwriteUnsafeLineTypes(raw.Line)
        if (unsafe.length) throw new NeedsReviewError('lines_changed', `This invoice has lines Pitt Stop can’t safely rebuild (${unsafe.join(', ')}) — review it in QuickBooks before updating the shared invoice.`)
      }
      // The manager reviewed a specific version of the invoice — never write over a newer one.
      if (params.expectedSyncToken != null && String(raw.SyncToken) !== String(params.expectedSyncToken)) throw new StaleReviewError()
      const liveFp = linesFingerprint(linesFromRawInvoice(raw.Line))
      // Shared invoice: QuickBooks must still hold exactly the lines Pitt Stop last wrote/verified (or this very
      // target, when an earlier ambiguous write landed) — never overwrite lines someone added in QuickBooks.
      if (shared && liveFp !== estL.qbLinesFingerprint && liveFp !== targetLinesFp && liveFp !== legacyLinesFp) throw new NeedsReviewError('lines_changed', 'The invoice was changed in QuickBooks since Pitt Stop last updated it — review it in QuickBooks before updating')
      const customerId = String(raw.CustomerRef?.value ?? '')
      if (included.length) {
        const mm = await sharedMemberCustomerMismatch(included, customerId)
        if (mm) throw new SharedMemberError('member_customer_mismatch', mm.orderId, mm.message)
      }
      const billEmail = contact.email && contact.email.trim() ? contact.email.trim() : (raw.BillEmail?.Address ?? null)
      const newHash = contentHash(customerId, payload, billEmail)
      const qbTotal = Math.round((raw.TotalAmt ?? 0) * 100)
      // No-op: content identical (lines+total+memo+email) AND QB total equals the draft.
      if (newHash === estL.qbContentHash && qbTotal === targetCents) {
        return { noop: true as const, written: { invoiceId: raw.Id, invoiceNumber: raw.DocNumber ?? null, syncToken: raw.SyncToken, totalAmtCents: qbTotal, lineCount: 0, linesFingerprint: liveFp }, newHash }
      }
      updateIssued = true
      const written = await updateRetailInvoiceInQB({ current: raw, lines: payload.lines, privateNote: payload.privateNote, customerMemo: payload.customerMemo, billEmail })
      return { noop: false as const, written, newHash }
    }

    let res
    try { res = await attempt() }
    catch (e) { if (e instanceof QBApiError && e.status === 409) res = await attempt(); else throw e }

    // Post-write invariant: QB TotalAmt must equal the authoritative total exactly (shared: Σ every Job's draft).
    if (!res.noop && res.written.totalAmtCents !== targetCents) {
      const msg = `QuickBooks TotalAmt ${res.written.totalAmtCents}¢ != Pitt Stop total ${targetCents}¢`
      await markError('qb_invoice_sync_failed', msg, 'error')
      return { ok: false, block: 'total_mismatch', invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, qbTotalCents: res.written.totalAmtCents, draftTotalCents: targetCents, error: msg }
    }

    // If a SENT invoice actually changed, the customer holds an older copy → flag
    // "Resend recommended" (invoice-id-first UI shows a Resend action; never auto-resends).
    const nextError = wasSent && !res.noop ? 'Resend recommended — invoice changed after it was emailed' : null
    // Persist the QuickBooks write result but KEEP the Sync lock held (qb_status stays 'syncing') until every
    // member is finalized below. Releasing it here (the old order) left a window in which a concurrent unlink —
    // fenced only on qb_status NOT IN ('syncing', 'creating', 'sending') — could remove a member whose charges
    // this write had just put on the invoice, stranding a billed vehicle and letting it create a second invoice.
    await db.update(jobEstimates).set({
      qbSyncToken: res.written.syncToken, qbContentHash: res.newHash,
      qbSyncedAt: new Date(), qbSyncError: nextError, qbLinesFingerprint: res.written.linesFingerprint, updatedAt: new Date(),
    }).where(eq(jobEstimates.id, est0.id))
    // Shared invoice: every included member is now on the invoice at its current total. Newly written members move
    // pending → applied (fenced on not-removed — unlink cannot run while this Sync lock is still held above).
    const appliedOrderIds: string[] = []
    for (const part of parts) {
      if (!part.member) continue
      const first = part.member.state === 'pending'
      await db.update(retailInvoiceMembers).set({ state: 'applied', appliedTotalCents: part.totalCents, ...(first ? { appliedAt: new Date(), appliedBy: actor } : {}), updatedAt: new Date() })
        .where(and(eq(retailInvoiceMembers.id, part.member.id), ne(retailInvoiceMembers.state, 'removed')))
      if (first) {
        appliedOrderIds.push(part.orderId)
        await logEvent({ serviceOrderId: part.orderId, eventType: 'shared_invoice_applied', employeeName: actor, note: `${part.vehicle} charges $${(part.totalCents / 100).toFixed(2)} added to shared invoice #${est0.qbInvoiceNumber} (${est0.qbInvoiceId})${wasSent ? ' · invoice was already emailed — NOT resent' : ''}` }).catch(() => {})
      }
    }
    // Membership is final — release the Sync lock LAST, back to its settled state. A DB failure before this point
    // falls to the catch below (qb_status → 'error', a re-runnable state): re-running the sync reconciles from
    // QuickBooks — the live lines already equal this target so the fingerprint check passes, the write is a no-op,
    // and any member still pending is applied — so a crash after the QB write can never duplicate or strand.
    await db.update(jobEstimates).set({ qbStatus: restore, updatedAt: new Date() }).where(eq(jobEstimates.id, est0.id))
    const breakdown = parts.length > 1 ? ` · shared: ${parts.map((p) => `${p.vehicle} $${(p.totalCents / 100).toFixed(2)}`).join(' + ')}` : ''
    await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_synced', employeeName: actor, note: `#${est0.qbInvoiceNumber} (${est0.qbInvoiceId}) ${res.noop ? 'no-op (already current)' : `updated · total $${(targetCents / 100).toFixed(2)}`}${breakdown}${wasSent ? ' · after send' : ''}` })
    if (appliedOrderIds.length) await logEvent({ serviceOrderId: orderId, eventType: 'shared_invoice_updated', employeeName: actor, note: `#${est0.qbInvoiceNumber} now bills ${parts.length} vehicles, total $${(targetCents / 100).toFixed(2)}${breakdown}` }).catch(() => {})
    if (wasSent && !res.noop) await logEvent({ serviceOrderId: orderId, eventType: 'qb_invoice_synced_after_send', employeeName: actor, note: `#${est0.qbInvoiceNumber} updated after it was emailed — customer may hold an older copy` }).catch(() => {})
    logger.info(APP, 'synced', { orderId, invoiceId: est0.qbInvoiceId, noop: res.noop, wasSent, shared: parts.length - 1, applied: appliedOrderIds.length })
    return { ok: true, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, alreadySent: wasSent, noop: res.noop, draftTotalCents: targetCents, appliedOrderIds }
  } catch (err) {
    // Refusals that change nothing: the invoice moved under a reviewed update, or a member Job isn't ready /
    // no longer bills this customer. These are all PRE-write (no QuickBooks change), so release the lock to the
    // PRIOR status (est0.qbStatus), NOT the settled `restore`. Critically, if the anchor was already 'error' from
    // an earlier ambiguous write whose charges landed, keep it 'error' — promoting it to created/sent would
    // re-open unlink for a billed pending member (duplicate-invoice risk).
    if (err instanceof StaleReviewError || err instanceof SharedMemberError) {
      await db.update(jobEstimates).set({ qbStatus: est0.qbStatus, updatedAt: new Date() }).where(eq(jobEstimates.id, est0.id))
      const block: SyncBlock = err instanceof StaleReviewError ? 'stale' : err.block
      await logEvent({ serviceOrderId: orderId, eventType: 'shared_invoice_update_refused', employeeName: actor, note: `${block}: ${err.message}` }).catch(() => {})
      return { ok: false, block, error: err.message, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, memberOrderId: err instanceof SharedMemberError ? err.orderId : undefined }
    }
    if (err instanceof NeedsReviewError) {
      // Same rule: preserve an existing 'error' status (a prior ambiguous write may have landed charges) rather
      // than promoting it to created/sent via `restore`.
      await markError('qb_invoice_sync_review', `Needs review — ${err.message}`, est0.qbStatus === 'error' ? 'error' : restore)
      return { ok: false, block: err.block, needsReview: true, reviewReason: err.message, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber }
    }
    const msg = err instanceof RetailTotalMismatchError ? err.message : safeErr(err)
    await markError('qb_invoice_sync_failed', msg, 'error')
    logger.error(APP, 'sync_failed', { orderId, error: msg })
    return { ok: false, block: 'sync_failed', error: msg, invoiceId: est0.qbInvoiceId, invoiceNumber: est0.qbInvoiceNumber, ambiguous: updateIssued && isAmbiguousWriteError(err) }
  }
}

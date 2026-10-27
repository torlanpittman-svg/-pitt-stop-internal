import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { estimateIntakes } from './schema'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { assertEstimateReady } from '@/apps/workflow/estimate-review'
import { getFullEstimate, itemizeEstimate, recomputeEstimate } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { getBusinessConfig } from '@/apps/settings/db'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { qbApiRequest } from '@/apps/quickbooks/client'
import { buildRetailWorkPayload } from '@/apps/quickbooks/retail-invoice-service'
import { resolveRetailCustomer, isPlaceholderEmail } from '@/apps/quickbooks/retail-customer'
import { extractPsid, buildCustomerMemo } from '@/apps/quickbooks/retail-format'
import { normalizeRecipients, recipientErrorMessage, sameRecipientSet } from './recipients'
import { listIncludedPhotoMeta } from '@/apps/order-photos/db'
import { prepareEstimateAttachments, reconcileEstimateAttachments, attachmentManifestFingerprint, attachmentSentIdentity } from './attachments'
import { validateCustomerNotes, customerNotesErrorMessage, composeEstimateMemo } from './notes'
import type { RetailPayload } from '@/apps/quickbooks/retail-invoice'

interface QBEstimate {
  Id: string; SyncToken: string; DocNumber?: string; TotalAmt?: number; PrivateNote?: string;
  CustomerRef?: { value?: string }; BillEmail?: { Address?: string }; EmailStatus?: string;
  Line?: { DetailType?: string; Description?: string; Amount?: number; SalesItemLineDetail?: { ItemRef?: { value?: string }; Qty?: number; UnitPrice?: number; TaxCodeRef?: { value?: string } } }[];
  CustomerMemo?: { value?: string };
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// `billEmail` is the recipient SET as a single comma-separated address string (one address in the common case).
export function estimateBody(payload: RetailPayload, customerId: string, billEmail: string) {
  return {
    CustomerRef: { value: customerId }, PrivateNote: payload.privateNote,
    CustomerMemo: { value: payload.customerMemo }, BillEmail: { Address: billEmail },
    Line: payload.lines.map(l => ({ DetailType: 'SalesItemLineDetail', Description: l.description, Amount: l.amountCents / 100,
      SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: 1, UnitPrice: l.amountCents / 100, TaxCodeRef: { value: 'NON' } } })),
  }
}

export function matchesEstimateContent(raw: QBEstimate, body: ReturnType<typeof estimateBody>) {
  const lines = (raw.Line ?? []).filter(l => l.DetailType === 'SalesItemLineDetail')
  return raw.CustomerMemo?.value === body.CustomerMemo.value && lines.length === body.Line.length && lines.every((line, i) => {
    const expected = body.Line[i]
    const detail = line.SalesItemLineDetail
    return line.Description === expected.Description && Math.round((line.Amount ?? 0) * 100) === Math.round(expected.Amount * 100)
      && detail?.ItemRef?.value === expected.SalesItemLineDetail.ItemRef.value
      && detail?.Qty === 1 && detail?.TaxCodeRef?.value === 'NON'
  })
}

export function assertEstimateIdentity(raw: QBEstimate, id: string, estimateId: string, customerId: string) {
  if (raw.Id !== id || extractPsid(raw.PrivateNote) !== estimateId || raw.CustomerRef?.value !== customerId) {
    throw new Error('The QuickBooks estimate no longer matches this customer. Review it in QuickBooks before continuing.')
  }
}

export async function intakeSummary(id: string) {
  const db = getDb()
  const [intake] = await db.select().from(estimateIntakes).where(eq(estimateIntakes.orderId, id))
  if (!intake) throw new Error('Estimate not found.')
  const order = await getOrderWithContext(id)
  if (!order) throw new Error('Estimate not found.')
  const [contact] = await db.select().from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, id))
  const full = await getFullEstimate(id)
  const cfg = await getBusinessConfig()
  const draft = buildInvoiceDraft({ order, full, paymentLabel: cfg.paymentLabel, role: 'manager' })
  // Selected photos join the preview revision ONLY when present, so a zero-photo estimate keeps the
  // exact legacy revision (and body/send identity) it had before attachments existed.
  const attachments = await listIncludedPhotoMeta(id)
  // Saved send recipients: NULL = legacy (no explicit list), [] = explicitly cleared, [a,…] = the saved set.
  // Folded into the preview revision ONLY when non-null, so a legacy estimate keeps its exact prior revision
  // (and body/send identity) until a list is first saved — and a later save then invalidates a stale preview.
  const savedRecipients = intake.savedRecipients ?? null
  const revision = fingerprint({ full: full && { estimate: { ...full.estimate, updatedAt: undefined, updatedBy: undefined }, services: full.services }, contact, notes: order.notes,
    ...(attachments.length ? { attachments: attachmentManifestFingerprint(attachments) } : {}),
    ...(savedRecipients !== null ? { savedRecipients } : {}) })
  return { intake, order, contact, full, draft, revision, attachments, savedRecipients }
}

/**
 * Resolve the explicit recipient SET for this one send. `recipientsInput === undefined` means the client
 * didn't pass an explicit list → DEFAULT it: use the saved recipient list when one exists (non-null), else
 * fall back to the saved customer contact email (the legacy NULL case). An explicit list — or a resolved
 * default — is normalized/validated here (empty/invalid/too-many and placeholder addresses are all rejected
 * BEFORE any QuickBooks side effect); an explicitly CLEARED saved list (`[]`) therefore blocks the send.
 *
 * Returns `list` (the canonical sorted, lowercased SET — used for confirmation and recipient-set
 * verification) and `joined` (the exact string written to BillEmail.Address + sendTo, so it is part of the
 * estimate hash / send identity). IDEMPOTENCY-PRESERVING CASE: when the set is exactly ONE address equal
 * (case-insensitively) to the stored customer contact, `joined` keeps the stored TRIMMED ORIGINAL casing —
 * so a revision already sent before this feature (whose body hash was computed from the trimmed-original
 * contact email) keeps the same body hash and the same ambiguous-retry request id, and never re-emails.
 * Any other explicit set uses the canonical lowercased join. The customer CONTACT email itself is passed
 * through unchanged elsewhere — it is used only for customer identity, never replaced by a recipient.
 */
function resolveRecipients(recipientsInput: string[] | undefined, contactEmail: string, savedRecipients: string[] | null): { list: string[]; joined: string } {
  const isDefault = recipientsInput === undefined
  // Default precedence: an explicit saved list (even an empty, cleared one) wins over the contact fallback.
  const fallback = savedRecipients !== null ? savedRecipients : (contactEmail ? [contactEmail] : [])
  const raw = recipientsInput ?? fallback
  const norm = normalizeRecipients(raw)
  if (!norm.ok) {
    if (!isDefault) throw new Error(recipientErrorMessage(norm.reason))
    const clearedSavedList = savedRecipients !== null && savedRecipients.length === 0
    throw new Error(clearedSavedList ? 'Add a recipient before sending this estimate.' : 'Add a valid customer email before sending.')
  }
  for (const address of norm.list) {
    if (isPlaceholderEmail(address)) throw new Error(isDefault ? 'Add a valid customer email before sending.' : 'Remove placeholder email addresses before sending.')
  }
  const stored = contactEmail.trim()
  const joined = norm.list.length === 1 && stored && norm.list[0] === stored.toLowerCase() ? stored : norm.joined
  return { list: norm.list, joined }
}

// Caller holds the shared intake lock. Preview revision is checked before any QB write/email.
// `recipients` is this send's explicit address list; omit it to default to the saved customer email.
export async function sendIntakeEstimate(id: string, actor: string, expectedRevision: string, recipients?: string[]) {
  const db = getDb()
  let state = await intakeSummary(id)
  if (state.order.status !== 'estimate') throw new Error('This estimate has already moved onto the Work Board.')
  if (state.revision !== expectedRevision) throw new Error('The estimate changed. Review the refreshed total before sending.')
  if (!state.draft.priced || !state.full?.services.some(s => s.source !== 'system')) throw new Error('Add services and a price first.')
  const contactEmail = state.contact?.customerEmail?.trim() || ''
  // Explicit recipients may send even when the customer has no stored email; the default path uses the saved
  // recipient list when one exists, otherwise the stored contact (legacy NULL) — and still requires one address.
  const { list: recipientList, joined: sendTo } = resolveRecipients(recipients, contactEmail, state.savedRecipients)
  if (state.draft.tax.cents || state.draft.tax.needsReview) throw new Error('Review tax treatment before sending this estimate through QuickBooks.')
  // Parts labor review / unchosen odor or ambiguous-name services — resolved before any QB write or email.
  await assertEstimateReady(id, 'send')
  if (state.full.estimate.priceMode === 'explicit_pretax') {
    await itemizeEstimate(state.full.estimate.id, actor)
    state = await intakeSummary(id)
  }
  const estimateId = state.full!.estimate.id
  // Customer-visible notes (e.g. an insurance claim number) append, clearly labeled, to the vehicle
  // CustomerMemo so they show on the estimate. Validate + compose BEFORE any QuickBooks side effect
  // (item resolve/create in buildRetailWorkPayload, and the customer create below): bad/over-long notes and
  // an over-long composed memo fail here, never truncated. The base memo is built with the SAME canonical
  // helper and vehicle shape buildRetailWorkPayload uses, so a note-free estimate keeps a byte-identical
  // memo (and therefore the same body/hash and idempotent retry identity).
  const notesCheck = validateCustomerNotes(state.full!.estimate.customerNotes)
  if (!notesCheck.ok) throw new Error(customerNotesErrorMessage(notesCheck.reason))
  const v = state.order.vehicle
  const customerMemo = composeEstimateMemo(
    buildCustomerMemo({ year: v.year, make: v.make, model: v.model, vin: v.vin, licensePlate: v.licensePlate }),
    notesCheck.notes,
  )
  // Customer identity is resolved from the CUSTOMER's own stored contact only (null allowed) — never
  // from a recipient, so sending to an insurer/third party can't attach the work to someone else.
  const customer = await resolveRetailCustomer({ name: state.contact!.customerName, email: contactEmail || null, phone: state.contact!.customerPhone })
  const { payload } = await buildRetailWorkPayload({ estimateId, order: state.order, full: state.full, draft: state.draft })
  const body = estimateBody({ ...payload, customerMemo }, customer.qbCustomerId, sendTo)
  const hash = fingerprint(body)
  let intake = state.intake
  const hadEstimateBefore = Boolean(intake.qbEstimateId)
  let raw: QBEstimate
  if (!intake.qbEstimateId) {
    const savedBody = intake.createBody ?? body
    if (!intake.createBody) await db.update(estimateIntakes).set({ createBody: savedBody }).where(eq(estimateIntakes.orderId, id))
    // Fixed request + fixed payload survive timeouts and local DB failures after QB succeeds.
    const response = await qbApiRequest<{ Estimate: QBEstimate }>({ method: 'POST', path: '/estimate', body: savedBody, query: { requestid: id } })
    raw = response.Estimate
    if (!raw?.Id) throw new Error('QuickBooks did not return an estimate ID. Retry to recover this request.')
    await db.update(estimateIntakes).set({ qbEstimateId: raw.Id, qbEstimateNumber: raw.DocNumber ?? null }).where(eq(estimateIntakes.orderId, id))
    intake = { ...intake, qbEstimateId: raw.Id }
  } else {
    raw = (await qbApiRequest<{ Estimate: QBEstimate }>({ path: `/estimate/${encodeURIComponent(intake.qbEstimateId)}` })).Estimate
  }
  assertEstimateIdentity(raw, intake.qbEstimateId!, estimateId, customer.qbCustomerId)
  // Always sync before an unsent/revised version. Stable request IDs also recover ambiguous updates.
  if (intake.qbHash === hash && !matchesEstimateContent(raw, body)) {
    throw new Error('The estimate was changed in QuickBooks. Review those changes before sending from the app.')
  }
  if (intake.qbHash !== hash) {
    const response = await qbApiRequest<{ Estimate: QBEstimate }>({ method: 'POST', path: '/estimate',
      body: { ...raw, ...body, sparse: false, SyncToken: raw.SyncToken },
      query: { requestid: `u-${fingerprint({ id, hash }).slice(0, 40)}` },
    })
    raw = response.Estimate
    assertEstimateIdentity(raw, intake.qbEstimateId!, estimateId, customer.qbCustomerId)
  }
  if (!matchesEstimateContent(raw, body)) throw new Error('QuickBooks estimate details do not match the current quote. Nothing was emailed.')
  if (Math.round((raw.TotalAmt ?? 0) * 100) !== payload.totalCents) throw new Error('QuickBooks total differs from this estimate. Nothing was emailed. Review the estimate in QuickBooks.')
  // Compare the recipient SET (ignoring spacing/case/order), so a confirmed send goes exactly where shown.
  if (!sameRecipientSet(raw.BillEmail?.Address, recipientList)) throw new Error('QuickBooks recipient differs from this estimate. Nothing was emailed.')
  await db.update(estimateIntakes).set({ qbHash: hash, qbEstimateNumber: raw.DocNumber ?? null }).where(eq(estimateIntakes.orderId, id))
  // Attachments: recheck the live manifest (a concurrent photo change aborts here), prepare email copies,
  // then reconcile + verify them against THIS validated estimate before any email leaves. `qbHash` stays
  // the BODY hash for the update logic above; the SEND identity folds in the prepared photo set so a
  // changed selection is a distinct, non-duplicating send (empty selection keeps the legacy body hash).
  const freshManifest = await listIncludedPhotoMeta(id)
  if (attachmentManifestFingerprint(freshManifest) !== attachmentManifestFingerprint(state.attachments)) {
    throw new Error('The attached photos changed. Review the refreshed estimate before sending.')
  }
  const prepared = await prepareEstimateAttachments(id, freshManifest)
  // A brand-new estimate with no photos skips the attachable query entirely (pure legacy path); any
  // existing estimate is reconciled so a deselected managed file is disabled and can't leak to email.
  if (prepared.length || hadEstimateBefore) {
    await reconcileEstimateAttachments({ orderId: id, qbEstimateId: raw.Id, prepared })
    // Reconcile (read bytes + upload) can be slow. Re-read the live selection immediately before the
    // send decision: if it changed during reconcile, stop — never carry a changed selection into /send.
    const preSendManifest = await listIncludedPhotoMeta(id)
    if (attachmentManifestFingerprint(preSendManifest) !== attachmentManifestFingerprint(freshManifest)) {
      throw new Error('The attached photos changed. Review the refreshed estimate before sending.')
    }
  }
  const sendIdentity = prepared.length ? fingerprint({ body: hash, attachments: attachmentSentIdentity(prepared) }) : hash
  if (intake.sentHash === sendIdentity) return { alreadySent: true }
  // Request ID is tied to the exact revision + attachment set, so a retry cannot send the same version twice.
  const response = await qbApiRequest<{ Estimate: QBEstimate }>({ method: 'POST', path: `/estimate/${encodeURIComponent(raw.Id)}/send`,
    query: { sendTo, requestid: `s-${fingerprint({ id, hash: sendIdentity }).slice(0, 40)}` }, headers: { 'Content-Type': 'application/octet-stream' },
  })
  if (response.Estimate?.EmailStatus !== 'EmailSent') throw new Error('QuickBooks has not confirmed delivery. Retry to check the same send request.')
  await db.update(estimateIntakes).set({ sentHash: sendIdentity, sentAt: new Date() }).where(eq(estimateIntakes.orderId, id))
  await logEvent({ serviceOrderId: id, eventType: 'qb_estimate_sent', employeeName: actor, note: `Estimate #${raw.DocNumber ?? raw.Id} → ${sendTo}` })
  return { alreadySent: false }
}

export async function refreshIntake(id: string) {
  const state = await intakeSummary(id)
  if (state.full) await recomputeEstimate(state.full.estimate.id)
  return intakeSummary(id)
}

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { estimateIntakes } from './schema'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { getFullEstimate, itemizeEstimate, recomputeEstimate } from '@/apps/workflow/estimate-db'
import { buildInvoiceDraft } from '@/apps/workflow/invoice-draft'
import { getBusinessConfig } from '@/apps/settings/db'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { qbApiRequest } from '@/apps/quickbooks/client'
import { buildRetailWorkPayload } from '@/apps/quickbooks/retail-invoice-service'
import { resolveRetailCustomer, isPlaceholderEmail } from '@/apps/quickbooks/retail-customer'
import { extractPsid } from '@/apps/quickbooks/retail-format'
import type { RetailPayload } from '@/apps/quickbooks/retail-invoice'

interface QBEstimate {
  Id: string; SyncToken: string; DocNumber?: string; TotalAmt?: number; PrivateNote?: string;
  CustomerRef?: { value?: string }; BillEmail?: { Address?: string }; EmailStatus?: string;
  Line?: { DetailType?: string; Description?: string; Amount?: number; SalesItemLineDetail?: { ItemRef?: { value?: string }; Qty?: number; UnitPrice?: number; TaxCodeRef?: { value?: string } } }[];
  CustomerMemo?: { value?: string };
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function estimateBody(payload: RetailPayload, customerId: string, email: string) {
  return {
    CustomerRef: { value: customerId }, PrivateNote: payload.privateNote,
    CustomerMemo: { value: payload.customerMemo }, BillEmail: { Address: email },
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
  const revision = fingerprint({ full: full && { estimate: { ...full.estimate, updatedAt: undefined, updatedBy: undefined }, services: full.services }, contact, notes: order.notes })
  return { intake, order, contact, full, draft, revision }
}

// Caller holds the shared intake lock. Preview revision is checked before any QB write/email.
export async function sendIntakeEstimate(id: string, actor: string, expectedRevision: string) {
  const db = getDb()
  let state = await intakeSummary(id)
  if (state.order.status !== 'estimate') throw new Error('This estimate has already moved onto the Work Board.')
  if (state.revision !== expectedRevision) throw new Error('The estimate changed. Review the refreshed total before sending.')
  if (!state.draft.priced || !state.full?.services.some(s => s.source !== 'system')) throw new Error('Add services and a price first.')
  const email = state.contact?.customerEmail?.trim() || ''
  if (!email || isPlaceholderEmail(email)) throw new Error('Add a valid customer email before sending.')
  if (state.draft.tax.cents || state.draft.tax.needsReview) throw new Error('Review tax treatment before sending this estimate through QuickBooks.')
  if (state.full.estimate.priceMode === 'explicit_pretax') {
    await itemizeEstimate(state.full.estimate.id, actor)
    state = await intakeSummary(id)
  }
  const estimateId = state.full!.estimate.id
  const customer = await resolveRetailCustomer({ name: state.contact!.customerName, email, phone: state.contact!.customerPhone })
  const { payload } = await buildRetailWorkPayload({ estimateId, order: state.order, full: state.full, draft: state.draft })
  const body = estimateBody(payload, customer.qbCustomerId, email)
  const hash = fingerprint(body)
  let intake = state.intake
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
  if (raw.BillEmail?.Address?.toLowerCase() !== email.toLowerCase()) throw new Error('QuickBooks recipient differs from this estimate. Nothing was emailed.')
  await db.update(estimateIntakes).set({ qbHash: hash, qbEstimateNumber: raw.DocNumber ?? null }).where(eq(estimateIntakes.orderId, id))
  if (intake.sentHash === hash) return { alreadySent: true }
  // Request ID is tied to the exact revision, so a retry cannot send the same version twice.
  const response = await qbApiRequest<{ Estimate: QBEstimate }>({ method: 'POST', path: `/estimate/${encodeURIComponent(raw.Id)}/send`,
    query: { sendTo: email, requestid: `s-${fingerprint({ id, hash }).slice(0, 40)}` }, headers: { 'Content-Type': 'application/octet-stream' },
  })
  if (response.Estimate?.EmailStatus !== 'EmailSent') throw new Error('QuickBooks has not confirmed delivery. Retry to check the same send request.')
  await db.update(estimateIntakes).set({ sentHash: hash, sentAt: new Date() }).where(eq(estimateIntakes.orderId, id))
  await logEvent({ serviceOrderId: id, eventType: 'qb_estimate_sent', employeeName: actor, note: `Estimate #${raw.DocNumber ?? raw.Id} → ${email}` })
  return { alreadySent: false }
}

export async function refreshIntake(id: string) {
  const state = await intakeSummary(id)
  if (state.full) await recomputeEstimate(state.full.estimate.id)
  return intakeSummary(id)
}

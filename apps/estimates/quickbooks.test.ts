import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const f = vi.hoisted(() => ({
  intake: {} as Record<string, unknown>, full: {} as Record<string, unknown>,
  contact: { customerName: 'Test Customer', customerEmail: 'customer@realshop.net', customerPhone: '5125550123' },
  api: vi.fn(), ready: vi.fn(), resolveCustomer: vi.fn(), order: { id: 'order', status: 'estimate', notes: null },
  payload: { lines: [{ itemId: 'labor', description: 'Interior detail', amountCents: 10000 }], privateNote: 'PSID:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', customerMemo: '2020 Honda Civic', totalCents: 10000 },
  // Attachments (own unit tests in apps/estimates/attachments.test.ts). Default: no selected photos.
  photos: [] as { id: string; imageHash: string; filename: string; contentType: string; byteSize: number; caption: string; storagePath: string }[],
  prepare: vi.fn(), reconcile: vi.fn(),
}))
vi.mock('@/platform/db', () => ({ getDb: () => ({
  select: () => ({ from: (table: { orderId?: unknown }) => ({ where: async () => [table.orderId ? { ...f.intake } : f.contact] }) }),
  update: () => ({ set: (patch: object) => ({ where: async () => { Object.assign(f.intake, patch) } }) }),
}) }))
vi.mock('@/apps/workflow/db', () => ({ getOrderWithContext: async () => f.order, logEvent: vi.fn() }))
vi.mock('@/apps/workflow/estimate-db', () => ({ getFullEstimate: async () => f.full, itemizeEstimate: vi.fn(), recomputeEstimate: vi.fn() }))
vi.mock('@/apps/workflow/invoice-draft', () => ({ buildInvoiceDraft: () => ({ priced: true, tax: { cents: 0, needsReview: false }, totalCents: 10000 }) }))
vi.mock('@/apps/settings/db', () => ({ getBusinessConfig: async () => ({ paymentLabel: 'Card charge' }) }))
vi.mock('@/apps/quickbooks/retail-invoice-service', () => ({ buildRetailWorkPayload: async () => ({ payload: f.payload }) }))
vi.mock('@/apps/quickbooks/retail-customer', () => ({ resolveRetailCustomer: f.resolveCustomer, isPlaceholderEmail: (s: string) => !s || s === 'no@no.com' }))
vi.mock('@/apps/quickbooks/client', () => ({ qbApiRequest: f.api, queryQBO: async () => ({}), qbUploadAttachment: vi.fn(), qboEscape: (s: string) => s }))
// Parts labor review / odor checks (own tests in apps/workflow/service-matching.test.ts).
vi.mock('@/apps/workflow/estimate-review', () => ({ assertEstimateReady: f.ready }))
vi.mock('@/apps/order-photos/db', () => ({ listIncludedPhotoMeta: async () => f.photos }))
// Attachment prepare/reconcile are exercised in attachments.test.ts; here we assert the WIRING only.
// Fingerprints are deterministic stand-ins so a zero-photo send keeps the legacy body/send identity.
vi.mock('./attachments', () => ({
  attachmentManifestFingerprint: (m: { id: string }[]) => `mf:${m.map((x) => x.id).join(',')}`,
  attachmentSentIdentity: (p: { photoId: string }[]) => `si:${p.map((x) => x.photoId).join(',')}`,
  prepareEstimateAttachments: f.prepare,
  reconcileEstimateAttachments: f.reconcile,
}))
import { sendIntakeEstimate, intakeSummary, estimateBody, assertEstimateIdentity } from './quickbooks'

const raw = () => ({ Id: 'qb-estimate', SyncToken: '1', ...estimateBody(f.payload, 'customer-id', f.contact.customerEmail), TotalAmt: 100, DocNumber: '1001' })
beforeEach(() => {
  f.intake = { orderId: 'order', qbEstimateId: null, qbEstimateNumber: null, qbHash: null, sentHash: null, createBody: null }
  f.full = { estimate: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', priceMode: 'itemized' }, services: [{ source: 'manual', title: 'Interior detail' }] }
  f.order.status = 'estimate'
  f.contact.customerEmail = 'customer@realshop.net'
  f.ready.mockReset().mockResolvedValue(undefined)
  f.resolveCustomer.mockReset().mockResolvedValue({ qbCustomerId: 'customer-id' })
  f.photos = []
  f.prepare.mockReset().mockImplementation(async (_orderId: string, metas: { id: string }[]) => metas.map((m) => ({ photoId: m.id })))
  f.reconcile.mockReset().mockResolvedValue(undefined)
  f.api.mockReset().mockImplementation(async (opts: { path: string }) => ({ Estimate: { ...raw(), ...(opts.path.endsWith('/send') ? { EmailStatus: 'EmailSent' } : {}) } }))
})
const send = async (recipients?: string[]) => sendIntakeEstimate('order', 'Manager', (await intakeSummary('order')).revision, recipients)

// A QuickBooks stub that echoes the posted BillEmail back on create/update (and on GET), so recipient-set
// verification runs against what we actually sent — the real QB would reflect the saved address list.
type ApiOpts = { method?: string; path: string; query?: Record<string, string>; body?: { BillEmail?: { Address?: string } } }
const echoRecipients = () => {
  let current = raw()
  f.api.mockImplementation(async (opts: ApiOpts) => {
    if (opts.path.endsWith('/send')) return { Estimate: { ...current, EmailStatus: 'EmailSent' } }
    if (opts.method === 'POST' && opts.path === '/estimate') {
      current = { ...raw(), ...(opts.body?.BillEmail ? { BillEmail: opts.body.BillEmail } : {}) }
    }
    return { Estimate: current }
  })
}
// Mirrors the module's internal fingerprint + send request id, so legacy (pre-feature) identities can be
// reconstructed in the test and compared against what the code emits now.
const fp = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const legacyBodyHash = (billEmail: string) => fp(estimateBody(f.payload, 'customer-id', billEmail))
const legacySendRequestId = (billEmail: string) => `s-${fp({ id: 'order', hash: legacyBodyHash(billEmail) }).slice(0, 40)}`
const sendCalls = () => f.api.mock.calls.filter((c) => (c[0] as ApiOpts).path.endsWith('/send'))
const createOrUpdateBodies = () => f.api.mock.calls.map((c) => c[0] as ApiOpts).filter((o) => o.method === 'POST' && o.path === '/estimate').map((o) => o.body)

describe('standalone QuickBooks estimates', () => {
  it('an estimate with an unresolved review (e.g. a part needing labor review) is refused before any QuickBooks call or email', async () => {
    f.ready.mockRejectedValueOnce(new Error('Resolve before sending the estimate: 1 part needs labor review'))
    await expect(send()).rejects.toThrow(/1 part needs labor review/)
    expect(f.ready).toHaveBeenCalledWith('order', 'send')
    expect(f.api).not.toHaveBeenCalled()
    expect(f.intake.sentAt).toBeUndefined()
  })
  it('creates and emails an Estimate, never an Invoice, and saves distinct linkage', async () => {
    await send()
    expect(f.intake.qbEstimateId).toBe('qb-estimate')
    expect(f.intake.sentAt).toBeInstanceOf(Date)
    const calls = f.api.mock.calls.map(c => c[0])
    expect(calls.every(c => !c.path.includes('invoice'))).toBe(true)
    expect(calls.find(c => c.path.endsWith('/send')).query.sendTo).toBe(f.contact.customerEmail)
    expect(f.intake).not.toHaveProperty('qbInvoiceId')
  })
  it('does not email an already-sent unchanged revision twice', async () => {
    await send(); await send()
    expect(f.api.mock.calls.filter(c => c[0].path.endsWith('/send'))).toHaveLength(1)
    expect(f.api.mock.calls.filter(c => c[0].path === '/estimate' && !c[0].body.Id)).toHaveLength(1)
  })
  it('reuses the persisted create payload and request ID after a timeout', async () => {
    f.api.mockRejectedValueOnce(new Error('timeout after QB accepted'))
    await expect(send()).rejects.toThrow('timeout')
    const first = f.api.mock.calls[0][0]
    expect(f.intake.createBody).toEqual(first.body)
    await send()
    const retry = f.api.mock.calls[1][0]
    expect(retry.body).toEqual(first.body)
    expect(retry.query.requestid).toBe(first.query.requestid)
  })
  it('retries an ambiguous send with the same request ID', async () => {
    let failed = false
    f.api.mockImplementation(async opts => {
      if (opts.path.endsWith('/send') && !failed) { failed = true; throw new Error('lost send response') }
      return { Estimate: { ...raw(), EmailStatus: 'EmailSent' } }
    })
    await expect(send()).rejects.toThrow('lost send')
    await send()
    const sends = f.api.mock.calls.filter(c => c[0].path.endsWith('/send'))
    expect(sends).toHaveLength(2)
    expect(sends[0][0].query.requestid).toBe(sends[1][0].query.requestid)
  })
  it('blocks same-total service changes made directly in QuickBooks', async () => {
    await send()
    f.api.mockResolvedValue({ Estimate: { ...raw(), Line: [{ ...raw().Line[0], Description: 'Different service' }] } })
    const calls = f.api.mock.calls.length
    await expect(send()).rejects.toThrow('changed in QuickBooks')
    expect(f.api.mock.calls.slice(calls).every(c => c[0].method !== 'POST')).toBe(true)
  })
  it('refuses a stale preview before any external writes', async () => {
    await expect(sendIntakeEstimate('order', 'Manager', 'stale')).rejects.toThrow('changed')
    expect(f.api).not.toHaveBeenCalled()
  })
  it('refuses quotes already moved to the board', async () => {
    f.order.status = 'arrived'
    await expect(send()).rejects.toThrow('Work Board')
    expect(f.api).not.toHaveBeenCalled()
  })
  it('blocks missing email and total mismatches without emailing', async () => {
    f.contact.customerEmail = ''
    await expect(send()).rejects.toThrow('email')
    expect(f.api).not.toHaveBeenCalled()
    f.contact.customerEmail = 'customer@realshop.net'
    f.api.mockResolvedValue({ Estimate: { ...raw(), TotalAmt: 999 } })
    await expect(send()).rejects.toThrow('total differs')
    expect(f.api.mock.calls.some(c => c[0].path.endsWith('/send'))).toBe(false)
  })
  it('refuses another customer or another estimate identity', () => {
    expect(() => assertEstimateIdentity(raw(), 'qb-estimate', 'wrong', 'customer-id')).toThrow('no longer matches')
    expect(() => assertEstimateIdentity(raw(), 'qb-estimate', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'wrong')).toThrow('no longer matches')
    expect(() => assertEstimateIdentity(raw(), 'different-id', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'customer-id')).toThrow('no longer matches')
  })
  it('preserves exact amounts and vehicle memo in the estimate payload', () => {
    const body = estimateBody(f.payload, 'customer-id', f.contact.customerEmail)
    expect(body.Line[0].Amount).toBe(100)
    expect(body.CustomerMemo.value).toBe('2020 Honda Civic')
    expect(body.Line[0].SalesItemLineDetail.ItemRef.value).toBe('labor')
  })
})

describe('standalone estimate — multiple send recipients', () => {
  it('with no recipients supplied, falls back to the single saved customer email', async () => {
    await send()
    expect(sendCalls()).toHaveLength(1)
    expect(sendCalls()[0][0].query.sendTo).toBe('customer@realshop.net')
  })

  it('sends multiple addresses as one comma-separated, sorted sendTo and sets BillEmail to the same list', async () => {
    echoRecipients()
    await send(['b@example.com', 'a@example.com'])
    expect(sendCalls()).toHaveLength(1)
    expect(sendCalls()[0][0].query.sendTo).toBe('a@example.com,b@example.com')
    expect(createOrUpdateBodies().some((b) => b?.BillEmail?.Address === 'a@example.com,b@example.com')).toBe(true)
  })

  it('a different recipient SET on the same unchanged quote is a new send with its own request id', async () => {
    echoRecipients()
    await send(['a@example.com'])
    await send(['a@example.com', 'b@example.com'])
    const sends = sendCalls()
    expect(sends).toHaveLength(2)
    expect(sends[0][0].query.requestid).not.toBe(sends[1][0].query.requestid)
    expect(sends[1][0].query.sendTo).toBe('a@example.com,b@example.com')
  })

  it('a reordered / duplicated / recased SAME set is one identity — it does not send twice', async () => {
    echoRecipients()
    await send(['a@example.com', 'b@example.com'])
    await send(['B@example.com', 'a@example.com', 'a@example.com'])
    expect(sendCalls()).toHaveLength(1)
  })

  it('retries a timed-out recipient send with the SAME request id and does not double-send', async () => {
    echoRecipients()
    let failed = false
    const base = f.api.getMockImplementation()!
    f.api.mockImplementation(async (opts: ApiOpts) => {
      if (opts.path.endsWith('/send') && !failed) { failed = true; throw new Error('lost send response') }
      return base(opts)
    })
    await expect(send(['a@example.com', 'b@example.com'])).rejects.toThrow('lost send')
    await send(['a@example.com', 'b@example.com'])
    const sends = sendCalls()
    expect(sends).toHaveLength(2)
    expect(sends[0][0].query.requestid).toBe(sends[1][0].query.requestid)
  })

  it('sends to explicit recipients even with no saved customer email, resolving identity from the customer contact only', async () => {
    f.contact.customerEmail = ''
    echoRecipients()
    await send(['insurer@acme.com'])
    expect(sendCalls()[0][0].query.sendTo).toBe('insurer@acme.com')
    // The customer resolver sees the customer's own (absent) contact, NEVER the recipient.
    expect(f.resolveCustomer).toHaveBeenCalledTimes(1)
    expect(f.resolveCustomer.mock.calls[0][0].email).toBeNull()
    expect(f.resolveCustomer.mock.calls[0][0].email).not.toBe('insurer@acme.com')
  })

  it('rejects empty, invalid, header-injection, and placeholder recipients before any QuickBooks call', async () => {
    await expect(send([])).rejects.toThrow(/at least one|valid customer email/)
    await expect(send(['not-an-email'])).rejects.toThrow(/valid recipient/i)
    await expect(send(['ok@x.com\nBcc: evil@x.com'])).rejects.toThrow(/valid recipient/i)
    await expect(send(['no@no.com'])).rejects.toThrow(/placeholder/i)
    expect(f.api).not.toHaveBeenCalled()
  })

  it('blocks when QuickBooks reports a different recipient set — nothing is emailed', async () => {
    f.api.mockImplementation(async (opts: ApiOpts) => {
      if (opts.path.endsWith('/send')) return { Estimate: { ...raw(), EmailStatus: 'EmailSent' } }
      return { Estimate: { ...raw(), BillEmail: { Address: 'someone-else@elsewhere.com' } } }
    })
    await expect(send(['a@example.com', 'b@example.com'])).rejects.toThrow(/recipient differs/)
    expect(sendCalls()).toHaveLength(0)
  })

  it('refuses a stale preview even with explicit recipients, before any external writes', async () => {
    await expect(sendIntakeEstimate('order', 'Manager', 'stale', ['a@example.com'])).rejects.toThrow('changed')
    expect(f.api).not.toHaveBeenCalled()
  })

  // ── Pre-release idempotency: an UPPERCASE stored contact email ──────────────────────────────────────
  // Before recipients existed, BillEmail/sendTo used the trimmed ORIGINAL-case contact email, and the body
  // hash came from it. Normalizing to lowercase would change that hash, re-emailing an already-sent revision
  // and shifting its ambiguous-retry request id. The resolver preserves the stored casing for a one-address
  // set equal to the contact, so these legacy identities are unchanged.
  it('does not re-email a revision already sent to an uppercase stored contact (legacy body hash preserved)', async () => {
    f.contact.customerEmail = 'Customer@RealShop.NET'
    const hash = legacyBodyHash('Customer@RealShop.NET')
    Object.assign(f.intake, { qbEstimateId: 'qb-estimate', qbHash: hash, sentHash: hash })
    const res = await send()                 // default path → single stored contact
    expect(res).toEqual({ alreadySent: true })
    expect(sendCalls()).toHaveLength(0)
  })

  it('keeps the legacy ambiguous-retry request id for an uppercase stored contact', async () => {
    f.contact.customerEmail = 'Customer@RealShop.NET'
    let failed = false
    f.api.mockImplementation(async (opts: ApiOpts) => {
      if (opts.path.endsWith('/send') && !failed) { failed = true; throw new Error('lost send response') }
      return { Estimate: { ...raw(), ...(opts.path.endsWith('/send') ? { EmailStatus: 'EmailSent' } : {}) } }
    })
    await expect(send()).rejects.toThrow('lost send')
    await send()
    const sends = sendCalls()
    expect(sends).toHaveLength(2)
    expect(sends[0][0].query.requestid).toBe(legacySendRequestId('Customer@RealShop.NET'))
    expect(sends[1][0].query.requestid).toBe(sends[0][0].query.requestid)
    // Casing is preserved on the wire, not lowercased.
    expect(sends[1][0].query.sendTo).toBe('Customer@RealShop.NET')
  })

  it('explicit lower/upper/duplicate variants of the stored contact are the same identity — no re-send, contact untouched', async () => {
    f.contact.customerEmail = 'Customer@RealShop.NET'
    await send()
    expect(sendCalls()).toHaveLength(1)
    expect(sendCalls()[0][0].query.requestid).toBe(legacySendRequestId('Customer@RealShop.NET'))
    // Same address, different case, duplicated → collapses to the one stored contact → already sent.
    await send(['customer@realshop.net', 'CUSTOMER@REALSHOP.NET'])
    expect(sendCalls()).toHaveLength(1)
    expect(f.contact.customerEmail).toBe('Customer@RealShop.NET')   // recipients never mutate the contact
  })
})

describe('standalone estimate — photo/parts attachments (wiring)', () => {
  const photo = (id: string) => ({ id, imageHash: `h-${id}`, filename: `${id}.jpg`, contentType: 'image/jpeg', byteSize: 1000, caption: '', storagePath: `order-photos/x/${id}.jpg` })

  it('zero-photo estimate sends exactly as before — no reconcile/attachable query', async () => {
    await send()
    expect(f.reconcile).not.toHaveBeenCalled()
    expect(sendCalls()).toHaveLength(1)
    expect(f.intake.sentAt).toBeInstanceOf(Date)
  })

  it('selected photos are prepared and reconciled against THIS estimate before anything is emailed', async () => {
    f.photos = [photo('p1'), photo('p2')]
    await send()
    expect(f.prepare).toHaveBeenCalledWith('order', f.photos)
    const arg = f.reconcile.mock.calls[0][0]
    expect(arg).toMatchObject({ orderId: 'order', qbEstimateId: 'qb-estimate' })
    expect(arg.prepared.map((p: { photoId: string }) => p.photoId)).toEqual(['p1', 'p2'])
    // reconcile fully precedes the /send call.
    const sendIdx = f.api.mock.calls.findIndex((c) => (c[0] as ApiOpts).path.endsWith('/send'))
    expect(f.reconcile.mock.invocationCallOrder[0]).toBeLessThan(f.api.mock.invocationCallOrder[sendIdx])
    expect(sendCalls()).toHaveLength(1)
  })

  it('stops the send if the selection changes DURING reconcile — the changed set is not carried into /send', async () => {
    f.photos = [photo('p1')]
    f.reconcile.mockImplementationOnce(async () => { f.photos = [photo('p2')] })
    await expect(send()).rejects.toThrow(/photos changed/)
    expect(sendCalls()).toHaveLength(0)
    expect(f.intake.sentAt).toBeUndefined()
  })

  it('a corrupt/missing/too-large photo fails BEFORE any email and before reconcile', async () => {
    f.photos = [photo('p1')]
    f.prepare.mockRejectedValueOnce(new Error('A selected photo failed its integrity check (p1.jpg). Nothing was emailed.'))
    await expect(send()).rejects.toThrow(/integrity check/)
    expect(f.reconcile).not.toHaveBeenCalled()
    expect(sendCalls()).toHaveLength(0)
    expect(f.intake.sentAt).toBeUndefined()
  })

  it('a reconcile/verify failure blocks the email', async () => {
    f.photos = [photo('p1')]
    f.reconcile.mockRejectedValueOnce(new Error('A photo attachment could not be verified in QuickBooks (p1.jpg). Nothing was emailed.'))
    await expect(send()).rejects.toThrow(/could not be verified/)
    expect(sendCalls()).toHaveLength(0)
    expect(f.intake.sentAt).toBeUndefined()
  })

  it('photos are part of the send identity: a new selection on an already-sent body re-sends once, repeats do not', async () => {
    // Legacy estimate already sent on its body hash (no photos); now the manager attaches a photo.
    const bodyHash = legacyBodyHash(f.contact.customerEmail)
    Object.assign(f.intake, { qbEstimateId: 'qb-estimate', qbHash: bodyHash, sentHash: bodyHash })
    f.photos = [photo('p1')]
    await send()
    expect(sendCalls()).toHaveLength(1)   // new attachment set → a fresh, explicit send
    await send()
    expect(sendCalls()).toHaveLength(1)   // same body + same photo set → already sent, no duplicate
    expect(f.reconcile.mock.calls.length).toBeGreaterThanOrEqual(2) // still reconciled/verified each time
  })

  it('removing all photos from a previously-managed estimate still reconciles (to disable leftovers)', async () => {
    Object.assign(f.intake, { qbEstimateId: 'qb-estimate', qbHash: null, sentHash: null })
    f.photos = []
    await send()
    // Existing estimate + empty selection → reconcile runs with an empty prepared set.
    expect(f.reconcile).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order', qbEstimateId: 'qb-estimate', prepared: [] }))
  })

  it('selected photos change the preview revision (so a stale preview is rejected)', async () => {
    const withNone = (await intakeSummary('order')).revision
    f.photos = [photo('p1')]
    const withOne = (await intakeSummary('order')).revision
    expect(withOne).not.toBe(withNone)
  })
})

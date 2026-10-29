/**
 * LOCAL PREVIEW FIXTURES — synthetic data ONLY. Nothing here touches the database, network, PartsTech,
 * OpenAI, or any real job. It builds an in-memory `ImportTransport` that drives the ACTUAL PartImportPanel so
 * the owner can click through each state with no production auth/data. Live AI extraction is NOT exercised —
 * the "read" step returns canned rows. No real secrets or data are present.
 *
 * Source values mirror the copied synthetic screenshots (scripts/parts-preview/assets):
 *   • NAPA “Sample Store” ORDER DEMO-24831 (placed, shop delivery): Brake pad set / DEMO-PAD-01 ×2 cost
 *     $59.50 line $119 list $92; Brake rotor / DEMO-ROT-02 ×2 cost $84 line $168 list $119; subtotal $287,
 *     core $20, tax $23.68, shipping $0, total $330.68.
 *   • O'Reilly “Sample Store” SAVED QUOTE (not ordered, no order #): Alternator / DEMO-ALT-03 ×1 list $289,
 *     purchase cost UNKNOWN, core $40.
 * The real images are served (dev-only) at /parts/preview/sample/order|quote so the owner can compare.
 */
import type { ImportTransport } from '@/app/orders/[id]/PartImportPanel'

let counter = 1
const id = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`

export type Scenario = 'order' | 'quote' | 'failed' | 'reading' | 'cancelled'

interface Row {
  id: string; sourceImageId: string | null; ordinal: number
  description: string | null; partNumber: string | null; brand: string | null; supplier: string | null
  quantity: number | null; unitCostCents: number | null; listPriceCents: number | null; lineTotalCents: number | null
  linkDecision: 'new' | 'link' | 'skip'; matchedPartId: string | null; appliedPartId: string | null
  issues: string[]; skuWarning: boolean
}
interface Batch {
  id: string; status: string; aiStatus: string; revision: number
  documentKind: 'purchase' | 'quote' | 'cart' | 'unknown'; supplier: string | null; orderReference: string | null
  taxCents: number | null; shippingCents: number | null; coreCents: number | null
  markOrdered: boolean; duplicateConfirmed: boolean
  images: Array<{ id: string; ordinal: number; contentType: string | null; label: string }>
  rows: Row[]; canMarkOrdered: boolean
}

const JOB = { orderId: id(), orderNumber: 'SO-SAMPLE-0007', vin: '1FTFW1ET5DFC90312', vehicle: '2013 Ford F-150 (SAMPLE)' }
const EXISTING = [{ id: id(), description: 'Brake pad set', partNumber: 'DEMO-PAD-01', supplier: 'NAPA Sample Store', status: 'needed', billed: false, quantity: 2, supplierOrderNumber: null, unitCostCents: null }]

function row(over: Partial<Row>, imageId: string): Row {
  return { id: id(), sourceImageId: imageId, ordinal: 0, description: null, partNumber: null, brand: null, supplier: null, quantity: null, unitCostCents: null, listPriceCents: null, lineTotalCents: null, linkDecision: 'new', matchedPartId: null, appliedPartId: null, issues: [], skuWarning: false, ...over }
}

function seed(scenario: Scenario): Batch {
  const imageId = id()
  const label = scenario === 'quote' ? 'quote' : 'order'
  const img = [{ id: imageId, ordinal: 0, contentType: 'image/png', label }]
  if (scenario === 'order') {
    return {
      id: id(), status: 'proposed', aiStatus: 'extracted', revision: 1, documentKind: 'purchase', supplier: 'NAPA Sample Store', orderReference: 'DEMO-24831',
      taxCents: 2368, shippingCents: 0, coreCents: 2000, markOrdered: false, duplicateConfirmed: false, images: img, canMarkOrdered: true,
      rows: [
        row({ description: 'Brake pad set', partNumber: 'DEMO-PAD-01', brand: 'NAPA', supplier: 'NAPA Sample Store', quantity: 2, unitCostCents: 5950, listPriceCents: 9200, lineTotalCents: 11900, skuWarning: true, ordinal: 0 }, imageId),
        row({ description: 'Brake rotor', partNumber: 'DEMO-ROT-02', brand: 'NAPA', supplier: 'NAPA Sample Store', quantity: 2, unitCostCents: 8400, listPriceCents: 11900, lineTotalCents: 16800, ordinal: 1 }, imageId),
      ],
    }
  }
  if (scenario === 'quote') {
    return {
      id: id(), status: 'proposed', aiStatus: 'extracted', revision: 1, documentKind: 'quote', supplier: "O'Reilly Sample Store", orderReference: null,
      taxCents: null, shippingCents: null, coreCents: 4000, markOrdered: false, duplicateConfirmed: false, images: img, canMarkOrdered: false,
      rows: [row({ description: 'Alternator', partNumber: 'DEMO-ALT-03', brand: "O'Reilly", supplier: "O'Reilly Sample Store", quantity: 1, unitCostCents: null, listPriceCents: 28900, lineTotalCents: null, issues: [], ordinal: 0 }, imageId)],
    }
  }
  if (scenario === 'failed') {
    return { id: id(), status: 'failed', aiStatus: 'failed', revision: 1, documentKind: 'unknown', supplier: null, orderReference: null, taxCents: null, shippingCents: null, coreCents: null, markOrdered: false, duplicateConfirmed: false, images: img, canMarkOrdered: false, rows: [] }
  }
  if (scenario === 'reading') {
    return { id: id(), status: 'reading', aiStatus: 'pending', revision: 1, documentKind: 'unknown', supplier: null, orderReference: null, taxCents: null, shippingCents: null, coreCents: null, markOrdered: false, duplicateConfirmed: false, images: img, canMarkOrdered: false, rows: [] }
  }
  return { id: id(), status: 'cancelled', aiStatus: 'extracted', revision: 1, documentKind: 'purchase', supplier: 'NAPA Sample Store', orderReference: 'DEMO-OLD', taxCents: null, shippingCents: null, coreCents: null, markOrdered: false, duplicateConfirmed: false, images: img, canMarkOrdered: false, rows: [row({ description: 'Brake rotor', partNumber: 'DEMO-ROT-02', quantity: 2, unitCostCents: 8400, ordinal: 0 }, imageId)] }
}

/** The full proposal view — EQUAL PERMISSIONS, so costs/totals/originals are returned to everyone (no
 *  redaction; honest shared capability, never a faked role). */
function view(b: Batch) {
  return {
    id: b.id, serviceOrderId: JOB.orderId, status: b.status, aiStatus: b.aiStatus, revision: b.revision,
    documentKind: b.documentKind, supplier: b.supplier, orderReference: b.orderReference,
    taxCents: b.taxCents, shippingCents: b.shippingCents, coreCents: b.coreCents,
    markOrdered: b.markOrdered, duplicateConfirmed: b.duplicateConfirmed,
    images: b.images.map((i) => ({ id: i.id, ordinal: i.ordinal, contentType: i.contentType })),
    rows: b.rows,
    warnings: { mixedSupplier: false, suppliers: b.supplier ? [b.supplier] : [], duplicateSupplierOrder: false, overlappingImages: false, pageConflicts: { supplier: false, orderReference: false, documentKind: false }, unreadImages: b.status === 'failed' ? 1 : 0, truncated: false },
    canMarkOrdered: b.canMarkOrdered, existingParts: EXISTING,
  }
}

/** Build a stateful in-memory transport seeded for a scenario. One shared capability for every user. */
export function makeFixtureTransport(scenario: Scenario = 'order'): ImportTransport {
  const batches: Batch[] = [seed(scenario)]
  const find = (bid: string) => batches.find((b) => b.id === bid)
  const summary = (b: Batch) => ({ id: b.id, status: b.status, documentKind: b.documentKind, supplier: b.supplier, orderReference: b.orderReference, rowCount: b.rows.length, appliedCount: b.rows.filter((r) => r.appliedPartId).length, createdAt: new Date().toISOString(), uploadedBy: 'Sample' })
  const imgLabel = (bid: string, iid: string) => find(bid)?.images.find((i) => i.id === iid)?.label ?? 'sample'
  const delay = <T,>(val: T): Promise<T> => new Promise((res) => setTimeout(() => res(val), 180))

  return {
    get: async (path) => {
      if (path === '') return delay({ ok: true, enabled: true, canReview: true, job: JOB, batches: batches.map(summary) })
      const b = find(path.slice(1))
      return delay(b ? { ok: true, canReview: true, batch: view(b) } : { ok: false, error: 'Not found.' })
    },
    post: async (path, body) => {
      const b = find(path.slice(1)); const action = (body as { action?: string })?.action
      if (!b) return delay({ ok: false, error: 'Not found.' })
      if (action === 'read') {
        if (b.status === 'uploaded' || b.status === 'failed' || b.status === 'reading') {
          // Simulate the AI read (or a stale-reading reclaim): a reading sample resolves to the order rows.
          if (b.status === 'reading' && b.rows.length === 0) { const o = seed('order'); b.rows = o.rows; b.supplier = o.supplier; b.orderReference = o.orderReference; b.documentKind = o.documentKind; b.taxCents = o.taxCents; b.coreCents = o.coreCents; b.canMarkOrdered = o.canMarkOrdered }
          b.status = b.rows.length ? 'proposed' : 'failed'; b.aiStatus = b.rows.length ? 'extracted' : 'failed'; b.revision++
        }
        return delay({ ok: true, canReview: true, batch: view(b), readStatus: b.status })
      }
      if (action === 'review') {
        const p = body as { supplier?: string | null; orderReference?: string | null; documentKind?: Batch['documentKind']; markOrdered?: boolean; rows?: Array<Partial<Row> & { id: string }> }
        if (p.supplier !== undefined) b.supplier = p.supplier
        if (p.orderReference !== undefined) b.orderReference = p.orderReference
        if (p.documentKind !== undefined) b.documentKind = p.documentKind
        if (p.markOrdered !== undefined) b.markOrdered = p.markOrdered
        b.canMarkOrdered = b.documentKind === 'purchase' && !!b.supplier && !!b.orderReference
        for (const pr of p.rows ?? []) { const r = b.rows.find((x) => x.id === pr.id); if (r) Object.assign(r, pr) }
        b.revision++
        return delay({ ok: true, canReview: true, batch: view(b) })
      }
      if (action === 'apply') {
        const opts = body as { duplicateConfirmed?: boolean; acknowledgeDuplicates?: boolean }
        const dupOrder = batches.some((x) => x !== b && x.status === 'applied' && (x.orderReference ?? '').toLowerCase() === (b.orderReference ?? '-').toLowerCase())
        if (dupOrder && !opts.duplicateConfirmed) return delay({ ok: false, needsDuplicateConfirm: true, error: 'This supplier order was already imported to this job.' })
        const skuDup = b.rows.some((r) => r.linkDecision === 'new' && r.skuWarning)
        if (skuDup && !opts.acknowledgeDuplicates && !opts.duplicateConfirmed) return delay({ ok: false, needsDuplicateAck: true, error: 'Some parts are already on the job.' })
        const bad = b.rows.find((r) => r.linkDecision === 'new' && (!r.description || !(r.quantity && r.quantity > 0)))
        if (bad) return delay({ ok: false, error: `Fix "${bad.description || 'a part'}": description and quantity required (or Skip it).` })
        b.status = 'applied'; b.revision++
        for (const r of b.rows) if (r.linkDecision !== 'skip') r.appliedPartId = id()
        return delay({ ok: true, canReview: true, batch: view(b) })
      }
      if (action === 'cancel') { b.status = 'cancelled'; b.revision++; return delay({ ok: true }) }
      return delay({ ok: false, error: 'Unknown action.' })
    },
    upload: async () => { const b = seed('order'); b.status = 'proposed'; batches.unshift(b); return delay({ ok: true, batchId: b.id, saved: true }) },
    // Serve the ACTUAL synthetic source PNG (dev-only route) so extracted rows can be compared to the image.
    imageUrl: (bid, iid) => `/parts/preview/sample/${imgLabel(bid, iid)}`,
  }
}

export const PREVIEW_JOB = JOB

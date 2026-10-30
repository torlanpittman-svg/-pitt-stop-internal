import { vi, describe, it, expect, beforeEach } from 'vitest'

// DB + queue layers are mocked — nothing here touches a database or the real print queue.
const h = vi.hoisted(() => ({
  select: vi.fn(), insert: vi.fn(),
  enqueue: vi.fn(), waiting: vi.fn(), latest: vi.fn(),
  expire: vi.fn(), transition: vi.fn(), getJob: vi.fn(), bridgeStatus: vi.fn(),
}))

vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/platform/db', () => ({
  getDb: () => ({
    select: () => {
      let table: unknown
      const b = {
        from(t: unknown) { table = t; return b },
        where() { return b },
        orderBy() { return b },
        limit() { return Promise.resolve(h.select(table)) },
      }
      return b
    },
    insert: (t: unknown) => ({ values: (vals: unknown) => ({ returning: () => Promise.resolve(h.insert(t, vals)) }) }),
  }),
}))
vi.mock('./queue', async (orig) => ({
  ...(await orig<typeof import('./queue')>()),
  enqueueStickerJob: h.enqueue, waitingStickerJobForOrder: h.waiting, latestStickerJobForOrder: h.latest,
}))
vi.mock('@/apps/checks/print-queue', async (orig) => ({
  ...(await orig<typeof import('@/apps/checks/print-queue')>()),
  expireStaleJobs: h.expire, transitionJob: h.transition, getJob: h.getJob, getBridgeStatus: h.bridgeStatus,
}))

import { queueStickerPrint, reprintSticker, stickerJobStatus, renderStickerJob, labelBridgeStatus, StickerValidationError } from './service'
import { serviceOrders, vehicles } from '@/apps/workflow/schema'
import { oilChangeStickers } from './schema'
import { buildStickerPayload } from './render'
import type { PrintJobRow } from './queue'

const ORDER = { id: 'O1', vehicleId: 'V1', status: 'in_progress' }
const ACTOR = { name: 'Tech' }
const INPUT = { mileage: 187781, intervalMiles: 5000, intervalMonths: 6 }

const job = (over: Partial<PrintJobRow> = {}): PrintJobRow => ({
  id: 'J1', checkId: null, kind: 'sticker', status: 'queued', printerTarget: 'label',
  payload: { kind: 'oil_sticker', stickerId: 'S1', orderId: 'O1' }, attempts: 0,
  claimedBy: null, claimedAt: null, printedAt: null, failedAt: null, error: null,
  createdBy: 'Tech', createdAt: new Date(), updatedAt: new Date(), ...over,
} as PrintJobRow)

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset())
  h.select.mockImplementation((table: unknown) => {
    if (table === serviceOrders) return [ORDER]
    if (table === vehicles) return [{ id: 'V1', year: '2019', make: 'Ford', model: 'F-150', color: 'Blue', licensePlate: 'ABC123' }]
    if (table === oilChangeStickers) return []
    return []
  })
  h.insert.mockImplementation((_t: unknown, vals: Record<string, unknown>) => [{ id: 'S-NEW', ...vals }])
  h.expire.mockResolvedValue([])
  h.waiting.mockResolvedValue(null)
  h.latest.mockResolvedValue(null)
  h.enqueue.mockImplementation(async () => job())
})

describe('queueStickerPrint — validation', () => {
  it('rejects a missing/negative mileage', async () => {
    await expect(queueStickerPrint('O1', { ...INPUT, mileage: -1 }, ACTOR)).rejects.toMatchObject({ code: 'bad_mileage' })
  })
  it('rejects a next mileage not past the current mileage', async () => {
    await expect(queueStickerPrint('O1', { ...INPUT, nextMileage: 187781 }, ACTOR)).rejects.toMatchObject({ code: 'bad_next_mileage' })
  })
  it('rejects a past or malformed next date', async () => {
    await expect(queueStickerPrint('O1', { ...INPUT, nextDate: '2020-01-01' }, ACTOR)).rejects.toMatchObject({ code: 'bad_next_date' })
    await expect(queueStickerPrint('O1', { ...INPUT, nextDate: 'soon' }, ACTOR)).rejects.toMatchObject({ code: 'bad_next_date' })
  })
  it('rejects out-of-range intervals instead of guessing', async () => {
    await expect(queueStickerPrint('O1', { ...INPUT, intervalMiles: 100 }, ACTOR)).rejects.toMatchObject({ code: 'bad_interval_miles' })
    await expect(queueStickerPrint('O1', { ...INPUT, intervalMonths: 0 }, ACTOR)).rejects.toMatchObject({ code: 'bad_interval_months' })
  })
  it('refuses a cancelled job', async () => {
    h.select.mockImplementation((table: unknown) => (table === serviceOrders ? [{ ...ORDER, status: 'cancelled' }] : []))
    await expect(queueStickerPrint('O1', INPUT, ACTOR)).rejects.toMatchObject({ code: 'order_cancelled' })
  })
})

describe('queueStickerPrint — queueing', () => {
  it('records the sticker and queues one labeled job with the printed values', async () => {
    const res = await queueStickerPrint('O1', INPUT, ACTOR)
    expect(res.alreadyQueued).toBe(false)
    expect(res.stickerId).toBe('S-NEW')
    expect(res.job.status).toBe('queued')
    const { payload } = h.enqueue.mock.calls[0][0]
    expect(payload.kind).toBe('oil_sticker')
    expect(payload.orderId).toBe('O1')
    expect(payload.texts.map((t: { value: string }) => t.value)).toContain('192,781 mi')
  })

  it('a double-tap returns the existing waiting job — no second sticker row, no second print', async () => {
    h.waiting.mockResolvedValue(job())
    const res = await queueStickerPrint('O1', INPUT, ACTOR)
    expect(res.alreadyQueued).toBe(true)
    expect(h.insert).not.toHaveBeenCalled()
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('losing the enqueue race returns the winner instead of erroring', async () => {
    h.enqueue.mockResolvedValue(null)
    h.waiting.mockResolvedValueOnce(null).mockResolvedValue(job({ id: 'J-WINNER' }))
    const res = await queueStickerPrint('O1', INPUT, ACTOR)
    expect(res.alreadyQueued).toBe(true)
    expect(res.job.jobId).toBe('J-WINNER')
  })

  it('manual overrides are honored over the computed values', async () => {
    await queueStickerPrint('O1', { ...INPUT, nextMileage: 200000, nextDate: '2027-01-15' }, ACTOR)
    const { payload } = h.enqueue.mock.calls[0][0]
    expect(payload.texts.map((t: { value: string }) => t.value)).toContain('200,000 mi')
    expect(payload.texts.map((t: { value: string }) => t.value)).toContain('Jan 15, 2027')
  })
})

describe('reprintSticker', () => {
  const ROW = { id: 'S1', orderId: 'O1', vehicleId: 'V1', mileage: 187781, intervalMiles: 5000, intervalMonths: 6, nextMileage: 192781, nextDate: '2027-04-30', nextDateText: 'Apr 30, 2027', createdBy: 'Tech', createdAt: new Date() }
  it('queues a new job from the stored sticker (explicit reprint)', async () => {
    h.select.mockImplementation((table: unknown) => (table === oilChangeStickers ? [ROW] : [ORDER]))
    const res = await reprintSticker('O1', 'S1', ACTOR)
    expect(res.alreadyQueued).toBe(false)
    const { payload } = h.enqueue.mock.calls[0][0]
    expect(payload.texts.map((t: { value: string }) => t.value)).toContain('Apr 30, 2027')
  })
  it('refuses while a job is still waiting', async () => {
    h.select.mockImplementation((table: unknown) => (table === oilChangeStickers ? [ROW] : [ORDER]))
    h.waiting.mockResolvedValue(job())
    const res = await reprintSticker('O1', 'S1', ACTOR)
    expect(res.alreadyQueued).toBe(true)
    expect(h.enqueue).not.toHaveBeenCalled()
  })
  it('rejects a sticker that belongs to another order', async () => {
    h.select.mockImplementation((table: unknown) => (table === oilChangeStickers ? [{ ...ROW, orderId: 'OTHER' }] : [ORDER]))
    await expect(reprintSticker('O1', 'S1', ACTOR)).rejects.toBeInstanceOf(StickerValidationError)
  })
})

describe('stickerJobStatus', () => {
  it('reflects expiry first, then reports the job', async () => {
    h.getJob.mockResolvedValue(job({ status: 'expired' }))
    const res = await stickerJobStatus('O1', 'J1')
    expect(h.expire).toHaveBeenCalled()
    expect(res.status).toBe('expired')
  })
  it('never leaks a job that belongs to another order or kind', async () => {
    h.getJob.mockResolvedValue(job({ payload: { kind: 'oil_sticker', stickerId: 'S1', orderId: 'OTHER' } }))
    await expect(stickerJobStatus('O1', 'J1')).rejects.toMatchObject({ code: 'job_not_found' })
    h.getJob.mockResolvedValue(job({ kind: 'check' }))
    await expect(stickerJobStatus('O1', 'J1')).rejects.toMatchObject({ code: 'job_not_found' })
  })
  it('flags a long-silent claimed job as uncertain', async () => {
    h.getJob.mockResolvedValue(job({ status: 'claimed', claimedAt: new Date(Date.now() - 10 * 60_000) }))
    const res = await stickerJobStatus('O1', 'J1')
    expect(res.uncertain).toBe(true)
  })
})

describe('renderStickerJob', () => {
  it('renders a real payload to a PDF', async () => {
    const payload = buildStickerPayload({ stickerId: 'S1', orderId: 'O1', values: { nextDateText: 'Feb 25, 2027', nextMileageText: '192,781 mi' } })
    const res = await renderStickerJob(job({ payload: payload as unknown as PrintJobRow['payload'] }))
    expect('pdf' in res && res.pdf.subarray(0, 4).toString()).toBe('%PDF')
    expect(h.transition).not.toHaveBeenCalled()
  })
  it('fails the job and refuses on a malformed payload — nothing is printed', async () => {
    const res = await renderStickerJob(job({ payload: { pageWidthIn: 8.5 } as unknown as PrintJobRow['payload'] }))
    expect(res).toHaveProperty('refused')
    expect(h.transition).toHaveBeenCalledWith('J1', ['claimed'], 'failed', expect.stringContaining('malformed'))
  })
})

describe('labelBridgeStatus', () => {
  it('requires an ONLINE bridge that declares a label printer', async () => {
    h.bridgeStatus.mockResolvedValue({ online: true, bridges: [
      { bridgeId: 'A', online: false, labelPrinter: 'Brother QL-800' },
      { bridgeId: 'B', online: true, labelPrinter: null },
    ] })
    expect(await labelBridgeStatus()).toEqual({ online: true, labelPrinterConfigured: false })
    h.bridgeStatus.mockResolvedValue({ online: true, bridges: [{ bridgeId: 'A', online: true, labelPrinter: 'Brother QL-800' }] })
    expect(await labelBridgeStatus()).toEqual({ online: true, labelPrinterConfigured: true })
  })
})

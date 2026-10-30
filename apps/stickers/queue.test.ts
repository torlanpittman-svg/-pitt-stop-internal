import { vi, describe, it, expect, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/platform/db', () => ({ getDb: () => ({ execute: h.execute }) }))

import { enqueueStickerJob, waitingStickerJobForOrder, toJob, isStickerUniqueViolation } from './queue'
import { claimNextJob } from '@/apps/checks/print-queue'
import type { StickerPrintPayload } from './render'

const payload = { kind: 'oil_sticker', stickerId: 'S1', orderId: 'O1' } as StickerPrintPayload
const snakeRow = {
  id: 'J1', check_id: null, kind: 'sticker', status: 'queued', printer_target: 'label',
  payload, attempts: 0, claimed_by: null, claimed_at: null, printed_at: null, failed_at: null,
  error: null, created_by: 'Tech', created_at: '2026-10-30T12:00:00Z', updated_at: '2026-10-30T12:00:00Z',
}

beforeEach(() => h.execute.mockReset())

describe('enqueueStickerJob', () => {
  it('returns the inserted job, normalised from snake_case', async () => {
    h.execute.mockResolvedValue({ rows: [snakeRow] })
    const job = await enqueueStickerJob({ payload, createdBy: 'Tech' })
    expect(job?.id).toBe('J1')
    expect(job?.printerTarget).toBe('label')
    expect(job?.createdAt).toBeInstanceOf(Date)
  })
  it('guarded insert refused (no row) → null, so the caller returns the existing job', async () => {
    h.execute.mockResolvedValue({ rows: [] })
    expect(await enqueueStickerJob({ payload })).toBeNull()
  })
  it('a concurrent unique-index violation is a lost race, anything else is a real error', () => {
    // (tested via the predicate — a spy-mocked rejection trips vitest's unhandled-rejection detector)
    expect(isStickerUniqueViolation(Object.assign(new Error('x'), { code: '23505' }))).toBe(true)
    expect(isStickerUniqueViolation(new Error('duplicate key value violates unique constraint "print_jobs_one_waiting_sticker_per_order"'))).toBe(true)
    expect(isStickerUniqueViolation(new Error('connection refused'))).toBe(false)
  })
  it('the insert is guarded on waiting sticker jobs for the same order', async () => {
    h.execute.mockResolvedValue({ rows: [snakeRow] })
    await enqueueStickerJob({ payload })
    const sqlText = JSON.stringify(h.execute.mock.calls[0][0])
    expect(sqlText).toContain('WHERE NOT EXISTS')
    expect(sqlText).toContain("'queued', 'claimed'")
    expect(sqlText).toContain("payload->>'orderId'")
  })
})

describe('waitingStickerJobForOrder', () => {
  it('maps the newest waiting job', async () => {
    h.execute.mockResolvedValue({ rows: [snakeRow] })
    expect((await waitingStickerJobForOrder('O1'))?.id).toBe('J1')
  })
  it('null when none', async () => {
    h.execute.mockResolvedValue({ rows: [] })
    expect(await waitingStickerJobForOrder('O1')).toBeNull()
  })
})

describe('claimNextJob kind filter (shared queue)', () => {
  it('an empty kind list claims nothing and never hits the database', async () => {
    expect(await claimNextJob('B', [])).toBeNull()
    expect(h.execute).not.toHaveBeenCalled()
  })
  it('the claim SQL restricts to the offered kinds', async () => {
    h.execute.mockResolvedValue({ rows: [] })
    await claimNextJob('B', ['check', 'reprint', 'specimen'])
    const sqlText = JSON.stringify(h.execute.mock.calls[0][0])
    expect(sqlText).toContain('kind IN')
  })
})

describe('toJob', () => {
  it('passes through camelCase rows and null', () => {
    expect(toJob(null)).toBeNull()
    const camel = { checkId: null, id: 'X' }
    expect(toJob(camel as Record<string, unknown>)).toBe(camel)
  })
})

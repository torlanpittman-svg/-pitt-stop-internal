/**
 * readBatch must treat a multi-screenshot read as all-or-nothing: if ANY page's AI read fails (or any page
 * can't be read), the whole read is a recoverable 'failed' — never a partial success presented as complete.
 * External storage/decode/AI are mocked; no network, no DB.
 */
import { it, expect, vi } from 'vitest'
import type { MergedExtraction } from './import-db'

const mocks = vi.hoisted(() => ({ persist: vi.fn(async (...args: unknown[]) => { void args; return { ok: true } }), read: vi.fn() }))
/** The 3rd arg to applyExtraction(batchId, token, merged) — typed so the assertions read cleanly. */
const persistedMerged = (callIndex: number): MergedExtraction => mocks.persist.mock.calls[callIndex][2] as MergedExtraction
vi.mock('@/apps/parts/import-db', () => ({
  claimBatchReading: async () => ({ ok: true, token: 'test', images: [{ id: 'one', storageRef: 'one' }, { id: 'two', storageRef: 'two' }] }),
  applyExtraction: mocks.persist,
  releaseBatchReading: vi.fn(),
}))
vi.mock('@/apps/parts/import-storage', () => ({ readImportImageBytes: async () => Buffer.from('synthetic') }))
vi.mock('@/apps/parts/import-image', () => ({ deriveForAi: async () => ({ bytes: Buffer.from('synthetic'), contentType: 'image/png' }) }))
vi.mock('@/apps/parts/import-ai', async (orig) => ({ ...await orig<typeof import('@/apps/parts/import-ai')>(), extractPartsImport: mocks.read }))

import { readBatch } from './import-read'
import { EMPTY_PROPOSAL, parsePartsImportJson } from './import-normalize'

it('an AI failure on one of two images cannot silently produce a complete proposal', async () => {
  mocks.read.mockResolvedValueOnce({ status: 'extracted', model: 'mock', raw: null, proposal: parsePartsImportJson({ supplier: 'NAPA', documentKind: 'purchase', orderReference: 'DEMO', lineItems: [{ description: 'Rotor', quantity: 1, unitCost: 20 }] }) })
  mocks.read.mockResolvedValueOnce({ status: 'failed', model: null, raw: { error: 'extract_failed' }, proposal: EMPTY_PROPOSAL })
  const result = await readBatch('test')
  expect(result.status).toBe('failed')
  expect(persistedMerged(0).aiStatus).toBe('failed')
  expect(persistedMerged(0).readWarnings?.unreadImages).toBe(0)
})

it('all pages extracted with ≥1 row persists an extracted proposal', async () => {
  mocks.persist.mockClear(); mocks.read.mockReset()
  mocks.read.mockResolvedValue({ status: 'extracted', model: 'mock', raw: null, proposal: parsePartsImportJson({ supplier: 'NAPA', documentKind: 'purchase', lineItems: [{ description: 'Rotor', quantity: 1, unitCost: 20 }] }) })
  const result = await readBatch('test')
  expect(result.status).toBe('proposed')
  expect(persistedMerged(0).aiStatus).toBe('extracted')
})

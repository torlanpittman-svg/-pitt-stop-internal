/**
 * PartsTech-screenshot import — the shared AI READ step (used by both the auto-read-after-upload and the
 * manager "retry"). Reads the preserved screenshots from PRIVATE storage, extracts each page's line items in
 * BOUNDED PARALLEL (≤4 images so one 15s blob + 35s AI fits the 60s function budget), merges them (conflicts
 * detected, never first-wins), and persists the proposal atomically via applyExtraction.
 *
 * Reliability: the batch is claimed with a processing token so concurrent reads can't collide; any image
 * that fails to load/decode is surfaced (not silently dropped); a read that yields ZERO usable rows, or where
 * any required screenshot could not be read, lands the batch 'failed' (actionable), never a fake 'proposed'.
 * The originals are already saved, so a failed read is always recoverable. Returns only a stable status/code
 * (never raw provider text) so nothing sensitive reaches the client or the logs.
 */
import { claimBatchReading, applyExtraction, releaseBatchReading } from './import-db'
import { readImportImageBytes } from './import-storage'
import { deriveForAi } from './import-image'
import { extractPartsImport, mergeProposals } from './import-ai'
import { EMPTY_PROPOSAL, MAX_BATCH_ROWS } from './import-normalize'

export interface ReadResult { ok: boolean; status?: 'proposed' | 'failed'; unreadImages?: number; error?: string; code?: string; busy?: boolean }

export async function readBatch(batchId: string): Promise<ReadResult> {
  const claim = await claimBatchReading(batchId)
  if (!claim.ok) return { ok: false, busy: true, error: claim.error, code: 'busy' }
  try {
    // Bounded parallel: one AI call per preserved screenshot.
    const perImage = await Promise.all(claim.images.map(async (img) => {
      const bytes = await readImportImageBytes(img.storageRef)
      if (!bytes) return { imageId: img.id, proposal: EMPTY_PROPOSAL, extracted: false, read: false, model: null as string | null, raw: { error: 'unreadable_storage' } as unknown }
      const derived = await deriveForAi(bytes)
      if (!derived) return { imageId: img.id, proposal: EMPTY_PROPOSAL, extracted: false, read: false, model: null as string | null, raw: { error: 'undecodable' } as unknown }
      const ai = await extractPartsImport(derived.bytes.toString('base64'), derived.contentType)
      return { imageId: img.id, proposal: ai.proposal, extracted: ai.status === 'extracted', read: true, model: ai.model, raw: ai.raw }
    }))

    const unreadImages = perImage.filter((p) => !p.read).length
    // EVERY required screenshot must have been read AND extracted; a single failed/unread page makes the whole
    // read a (recoverable) failure — never a partial success presented as complete.
    const allExtracted = perImage.length > 0 && perImage.every((p) => p.extracted)
    const merged = mergeProposals(perImage.map((p) => ({ imageId: p.imageId, proposal: p.proposal })))
    const model = perImage.find((p) => p.model)?.model ?? null
    // Bound the MERGED result to the same cap the review route accepts; flag truncation (per-page truncation
    // OR a merged overflow) so the reviewer knows to add any missing lines manually.
    const mergedOverflow = merged.rows.length > MAX_BATCH_ROWS
    if (mergedOverflow) merged.rows = merged.rows.slice(0, MAX_BATCH_ROWS)
    const truncated = mergedOverflow || perImage.some((p) => p.proposal.rawRowCount > p.proposal.rows.length)
    const aiStatus: 'extracted' | 'failed' = allExtracted && merged.rows.length >= 1 ? 'extracted' : 'failed'
    const readWarnings = { supplier: merged.conflicts.supplier, orderReference: merged.conflicts.orderReference, documentKind: merged.conflicts.documentKind, unreadImages, truncated }

    // A fruitless read (no usable rows at all) must NOT wipe a prior proposal — release to 'failed'.
    if (merged.rows.length === 0) {
      await releaseBatchReading(batchId, claim.token, true)
      return { ok: true, status: 'failed', unreadImages }
    }
    const applied = await applyExtraction(batchId, claim.token, {
      aiStatus, aiModel: model, aiRaw: { images: perImage.map((p) => ({ imageId: p.imageId, raw: p.raw })) },
      documentKind: merged.documentKind, supplier: merged.supplier, orderReference: merged.orderReference,
      taxCents: merged.taxCents, shippingCents: merged.shippingCents, coreCents: merged.coreCents,
      rows: merged.rows, readWarnings,
    })
    if (!applied.ok) return { ok: false, error: 'This read is no longer current.', code: 'stale' }
    const status = aiStatus === 'extracted' ? 'proposed' : 'failed'
    return { ok: true, status, unreadImages }
  } catch {
    // applyExtraction never ran (or threw): release the lock back to a recoverable 'failed'.
    await releaseBatchReading(batchId, claim.token, true).catch(() => {})
    return { ok: false, error: 'Could not read the screenshots — they are saved; retry or enter parts manually.', code: 'read_failed' }
  }
}

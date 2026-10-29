/**
 * Parts screenshot import — original screenshot retrieval (job-scoped). Streams the preserved PRIVATE
 * screenshot bytes so ANY authorized shop user reviewing the import can see the source (equal permissions —
 * same import gate as the rest of the workflow, no manager-only restriction). No public URL/token ever leaves
 * the server; retrieval stays private and job-/batch-/image-scoped. Authorization is re-verified here (not
 * just the UI) via the shared import gate (valid session + feature enabled + parts visible), AND the image
 * must belong to the given batch which must belong to the given order.
 */
import { NextResponse } from 'next/server'
import { getBatch, listBatchImages } from '@/apps/parts/import-db'
import { readImportImageBytes } from '@/apps/parts/import-storage'
import { importGate, isUuid } from '../../../_gate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string; batchId: string; imageId: string }> }) {
  const g = await importGate(req)
  if ('response' in g) return g.response
  const { id, batchId, imageId } = await params
  if (!isUuid(id) || !isUuid(batchId) || !isUuid(imageId)) return NextResponse.json({ ok: false, error: 'Bad id.' }, { status: 400 })
  // Provenance: the batch must be on THIS order, and the image on THIS batch.
  const batch = await getBatch(batchId, id)
  if (!batch) return NextResponse.json({ ok: false, error: 'Import not found on this order.' }, { status: 404 })
  const image = (await listBatchImages(batchId)).find((i) => i.id === imageId)
  if (!image) return NextResponse.json({ ok: false, error: 'Screenshot not found.' }, { status: 404 })
  const bytes = await readImportImageBytes(image.storageRef)
  if (!bytes) return NextResponse.json({ ok: false, error: 'Could not load the screenshot.' }, { status: 502 })
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': image.contentType || 'image/jpeg', 'Cache-Control': 'private, no-store', 'Content-Length': String(bytes.length) },
  })
}

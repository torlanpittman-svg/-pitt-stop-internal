/**
 * Parts screenshot import — original screenshot retrieval (MANAGER-ONLY, job-scoped). Streams the preserved
 * private screenshot bytes so a reviewing manager can see the source during review. No public URL/token ever
 * leaves the server. Authorization is re-verified here (not just the UI): valid session + manager + the
 * feature flag, AND the image must belong to the given batch which must belong to the given order.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { partsScreenshotImportEnabled } from '@/apps/parts/visibility'
import { getBatch, listBatchImages } from '@/apps/parts/import-db'
import { readImportImageBytes } from '@/apps/parts/import-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string; batchId: string; imageId: string }> }) {
  if (!partsScreenshotImportEnabled()) return NextResponse.json({ ok: false, error: 'Not enabled.' }, { status: 403 })
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || !isManagerRole(actor.role)) return NextResponse.json({ ok: false, error: 'Manager access required.' }, { status: 403 })
  const { id, batchId, imageId } = await params
  const isUuid = (s: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)
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

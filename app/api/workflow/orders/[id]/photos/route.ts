import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { photoAccess, photoError } from '@/apps/order-photos/access'
import { listOrderPhotos, saveOrderPhoto } from '@/apps/order-photos/db'
import { storePhotoBytes } from '@/apps/order-photos/storage'
import { validatePhoto } from '@/apps/order-photos/validation'
import { MAX_PHOTO_BYTES } from '@/apps/order-photos/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Context) {
  try {
    const { id } = await params
    const access = await photoAccess(req, id)
    if (access.response) return access.response
    return NextResponse.json({ ok: true, photos: await listOrderPhotos(id) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch { return photoError('Could not load photos. Please try again.', 500) }
}

export async function POST(req: Request, { params }: Context) {
  try {
    const { id } = await params
    const access = await photoAccess(req, id)
    if (access.response) return access.response
    if (Number(req.headers.get('content-length')) > MAX_PHOTO_BYTES + 256 * 1024) return photoError('This photo is too large.', 413)
    const form = await req.formData().catch(() => null)
    const file = form?.get('photo')
    if (!(file instanceof File)) return photoError('Choose a photo first.', 400)
    const valid = await validatePhoto(file)
    if (!valid.ok) return photoError(valid.error, valid.status)
    const hash = createHash('sha256').update(valid.bytes).digest('hex')
    const path = `order-photos/${id.toLowerCase()}/${hash}.${valid.extension}`
    let storagePath: string
    try { storagePath = await storePhotoBytes(path, valid.bytes, valid.contentType) }
    catch { return photoError('Could not save the photo. Please try again or check photo storage setup.', 502) }
    const photo = await saveOrderPhoto({
      serviceOrderId: id, storagePath, imageHash: hash, filename: valid.filename,
      contentType: valid.contentType, byteSize: valid.bytes.length, uploadedBy: access.actor.name,
      resized: form?.get('resized') === 'true',
    })
    return NextResponse.json({ ok: true, photo })
  } catch { return photoError('Could not save the photo. Please try again.', 500) }
}

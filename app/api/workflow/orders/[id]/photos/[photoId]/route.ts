import { NextResponse } from 'next/server'
import { photoAccess, photoError, isPhotoId } from '@/apps/order-photos/access'
import { getOrderPhoto, updateOrderPhoto } from '@/apps/order-photos/db'
import { readPhotoBytes } from '@/apps/order-photos/storage'
import { MAX_CAPTION_LENGTH } from '@/apps/order-photos/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string; photoId: string }> }

export async function GET(req: Request, { params }: Context) {
  try {
    const { id, photoId } = await params
    const access = await photoAccess(req, id)
    if (access.response) return access.response
    if (!isPhotoId(photoId)) return photoError('Photo not found.', 404)
    const row = await getOrderPhoto(id, photoId)
    if (!row) return photoError('Photo not found.', 404)
    const bytes = await readPhotoBytes(row.storagePath)
    if (!bytes) return photoError('Photo not found.', 404)
    const download = new URL(req.url).searchParams.get('download') === '1'
    return new NextResponse(new Uint8Array(bytes), { headers: {
      'Content-Type': row.contentType,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${row.filename.replace(/[^a-z0-9._-]/gi, '_')}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Length': String(bytes.length),
    } })
  } catch { return photoError('Could not load the photo. Please try again.', 500) }
}

export async function PATCH(req: Request, { params }: Context) {
  try {
    const { id, photoId } = await params
    const access = await photoAccess(req, id)
    if (access.response) return access.response
    if (!isPhotoId(photoId)) return photoError('Photo not found.', 404)
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (body.caption === undefined && body.included === undefined)
      || (body.caption !== undefined && (typeof body.caption !== 'string' || body.caption.length > MAX_CAPTION_LENGTH))
      || (body.included !== undefined && typeof body.included !== 'boolean')) return photoError('Enter a caption of 500 characters or less and a valid photo selection.', 400)
    const photo = await updateOrderPhoto(id, photoId, {
      ...(body.caption !== undefined ? { caption: body.caption.trim() } : {}),
      ...(body.included !== undefined ? { included: body.included } : {}),
    })
    return photo ? NextResponse.json({ ok: true, photo }) : photoError('Photo not found.', 404)
  } catch { return photoError('Could not save this change. Please try again.', 500) }
}

export async function DELETE(req: Request, { params }: Context) {
  try {
    const { id, photoId } = await params
    const access = await photoAccess(req, id)
    if (access.response) return access.response
    if (!isPhotoId(photoId)) return photoError('Photo not found.', 404)
    const photo = await updateOrderPhoto(id, photoId, { removedAt: new Date() })
    return photo ? NextResponse.json({ ok: true }) : photoError('Photo not found.', 404)
  } catch { return photoError('Could not remove the photo. Please try again.', 500) }
}

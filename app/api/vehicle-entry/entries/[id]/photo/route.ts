import { getVehicleEntry } from '@/apps/vehicle-entry/db'

/**
 * Serves the key tag photo for a vehicle entry.
 * In demo mode, photoUrl is a base64 data URL — this route decodes it
 * and streams it as a proper image response so page HTML stays small.
 * In production, it redirects to the Vercel Blob CDN URL.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const entry = await getVehicleEntry(id)

  if (!entry) {
    return new Response('Not found', { status: 404 })
  }

  if (entry.photoUrl.startsWith('manual://') || entry.photoUrl.startsWith('test://')) {
    return new Response('No photo', { status: 404 })
  }

  if (entry.photoUrl.startsWith('data:')) {
    const commaIdx = entry.photoUrl.indexOf(',')
    const header = entry.photoUrl.slice(0, commaIdx)  // e.g. "data:image/jpeg;base64"
    const mimeType = header.split(':')[1].split(';')[0]
    const buffer = Buffer.from(entry.photoUrl.slice(commaIdx + 1), 'base64')
    return new Response(buffer, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  }

  // Production: redirect to Vercel Blob CDN
  return Response.redirect(entry.photoUrl, 302)
}

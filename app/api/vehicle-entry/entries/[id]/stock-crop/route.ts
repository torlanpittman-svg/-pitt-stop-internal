import { getVehicleEntry } from '@/apps/vehicle-entry/db'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const entry = await getVehicleEntry(id)

  if (!entry?.stockNumberCropUrl) {
    return new Response('Not found', { status: 404 })
  }

  if (entry.stockNumberCropUrl.startsWith('data:')) {
    const commaIdx = entry.stockNumberCropUrl.indexOf(',')
    const header   = entry.stockNumberCropUrl.slice(0, commaIdx)
    const mimeType = header.split(':')[1].split(';')[0]
    const buffer   = Buffer.from(entry.stockNumberCropUrl.slice(commaIdx + 1), 'base64')
    return new Response(buffer, {
      headers: {
        'Content-Type':  mimeType,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  }

  return Response.redirect(entry.stockNumberCropUrl, 302)
}

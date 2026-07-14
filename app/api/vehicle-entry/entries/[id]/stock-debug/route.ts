import { getVehicleEntry } from '@/apps/vehicle-entry/db'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const entry = await getVehicleEntry(id)

  if (!entry?.stockDebugOverlayUrl) {
    return new Response('Not found', { status: 404 })
  }

  if (entry.stockDebugOverlayUrl.startsWith('data:')) {
    const commaIdx = entry.stockDebugOverlayUrl.indexOf(',')
    const header   = entry.stockDebugOverlayUrl.slice(0, commaIdx)
    const mimeType = header.split(':')[1].split(';')[0]
    const buffer   = Buffer.from(entry.stockDebugOverlayUrl.slice(commaIdx + 1), 'base64')
    return new Response(buffer, {
      headers: { 'Content-Type': mimeType, 'Cache-Control': 'private, max-age=3600' },
    })
  }

  return Response.redirect(entry.stockDebugOverlayUrl, 302)
}

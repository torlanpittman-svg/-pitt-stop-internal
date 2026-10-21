/**
 * GET /api/book/vehicles — PUBLIC vehicle picker lists for /book (no customer data in or out).
 *   ?type=car|motorcycle|trailer                    → { years }
 *   ?type=…&year=2020                               → { makes }   (trailer: { models } = trailer kinds)
 *   ?type=…&year=2020&make=Toyota                   → { models, source }  source: nhtsa | fallback | unavailable
 */
import { NextResponse } from 'next/server'
import { isOnlineType, makesFor, modelsFor, yearsFor } from '@/apps/appointments/vehicles'

export const runtime = 'nodejs'

const CACHE = { 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800' }

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const type = sp.get('type') ?? ''
  if (!isOnlineType(type)) return NextResponse.json({ ok: false, error: 'Choose a vehicle type.' }, { status: 400 })
  const year = sp.get('year') ?? ''
  if (!year) return NextResponse.json({ ok: true, years: yearsFor() }, { headers: CACHE })
  if (!yearsFor().includes(year)) return NextResponse.json({ ok: false, error: 'Choose a year from the list.' }, { status: 400 })
  if (type === 'trailer') {
    const { models } = await modelsFor('trailer', year, 'Trailer')
    return NextResponse.json({ ok: true, models, source: 'fixed' }, { headers: CACHE })
  }
  const make = sp.get('make') ?? ''
  if (!make) return NextResponse.json({ ok: true, makes: makesFor(type, year) }, { headers: CACHE })
  if (!makesFor(type, year).includes(make)) return NextResponse.json({ ok: false, error: 'Choose a make from the list.' }, { status: 400 })
  const list = await modelsFor(type, year, make)
  // Never cache an outage at the edge — the next customer should get the real list once NHTSA is back.
  return NextResponse.json({ ok: true, models: list.models, source: list.source }, { headers: list.source === 'nhtsa' ? CACHE : { 'Cache-Control': 'no-store' } })
}

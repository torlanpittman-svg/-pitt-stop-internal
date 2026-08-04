/**
 * POST /api/quick-entry/plate-lookup  { plate, state }
 *
 * License Plate + State → VIN, then validate/decode via NHTSA vPIC. Only runs on an
 * explicit request (the UI calls this when the employee taps "Look Up Vehicle" —
 * never while typing). Successful lookups are cached per (plate, state) so repeat
 * scans don't re-bill the provider. Provider credentials stay server-side.
 */
import { NextResponse } from 'next/server'
import { and, eq, gt, sql as dsql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { plateLookupCache } from '@/apps/quick-entry/schema'
import { getPlateProvider, isPlateLookupEnabled, normalizePlate, isValidState } from '@/apps/quick-entry/plate-lookup'
import { decodeVINFromNHTSA, validateVIN, normalizeVIN } from '@/apps/vehicle-entry/vin'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LOG = 'api:quick-entry:plate-lookup'
const CACHE_TTL_DAYS = 30

export async function POST(request: Request) {
  if (!isPlateLookupEnabled()) {
    return NextResponse.json({ ok: false, error: 'Plate lookup is not enabled.' }, { status: 503 })
  }
  const provider = getPlateProvider()!

  const body = (await request.json().catch(() => ({}))) as { plate?: string; state?: string }
  const plate = normalizePlate(body.plate ?? '')
  const state = (body.state ?? '').toUpperCase()
  if (!plate) return NextResponse.json({ ok: false, error: 'Enter a license plate.' }, { status: 400 })
  if (!isValidState(state)) return NextResponse.json({ ok: false, error: 'Select a valid US state.' }, { status: 400 })

  const db = getDb()

  // Decode helper: turn a VIN into canonical NHTSA fields (+ provider trim), validated.
  const decode = async (vin: string | null, providerTrim: string | null, status: string, requestId: string | null, cached: boolean) => {
    if (!vin) {
      return NextResponse.json({ ok: false, notFound: true, provider: provider.name, status, requestId,
        error: 'No vehicle found for that plate + state. Try a VIN photo or enter the vehicle manually.' })
    }
    const norm = normalizeVIN(vin)
    let year: string | null = null, make: string | null = null, model: string | null = null, bodyClass: string | null = null
    if (validateVIN(norm).valid) {
      try { const d = await decodeVINFromNHTSA(norm); year = d.year; make = d.make; model = d.model; bodyClass = d.bodyClass }
      catch (err) { logger.error(LOG, 'nhtsa.decode.failed', { error: String(err) }) }
    }
    return NextResponse.json({
      ok: true, vin: norm, year, make, model, bodyClass, trim: providerTrim,
      provider: provider.name, status, requestId, cached,
    })
  }

  // 1) Cache hit (within TTL)?
  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86_400_000)
  const [hit] = await db.select().from(plateLookupCache)
    .where(and(eq(plateLookupCache.plate, plate), eq(plateLookupCache.state, state), gt(plateLookupCache.updatedAt, cutoff)))
    .limit(1)
  if (hit && hit.vin) {
    logger.info(LOG, 'plate.cache.hit', { plate, state })
    return decode(hit.vin, hit.trim ?? null, hit.status ?? 'cached', null, true)
  }

  // 2) Provider lookup (billable)
  logger.info(LOG, 'plate.lookup.start', { plate, state, provider: provider.name })
  const r = await provider.lookup(plate, state)
  logger.info(LOG, 'plate.lookup.done', { plate, state, status: r.status, found: !!r.vin })

  // 3) Cache the result (VIN + provider fields; NHTSA decode happens at read time)
  if (r.vin) {
    const norm = normalizeVIN(r.vin)
    let bodyClass: string | null = null
    if (validateVIN(norm).valid) { try { bodyClass = (await decodeVINFromNHTSA(norm)).bodyClass } catch { /* non-fatal */ } }
    await db.insert(plateLookupCache).values({
      plate, state, vin: norm, provider: provider.name, status: r.status,
      year: r.year ?? null, make: r.make ?? null, model: r.model ?? null, trim: r.trim ?? null, bodyClass,
    }).onConflictDoUpdate({
      target: [plateLookupCache.plate, plateLookupCache.state],
      set: { vin: norm, provider: provider.name, status: r.status, year: r.year ?? null, make: r.make ?? null,
        model: r.model ?? null, trim: r.trim ?? null, bodyClass, updatedAt: dsql`now()` },
    })
  }

  return decode(r.vin, r.trim ?? null, r.status, r.requestId, false)
}

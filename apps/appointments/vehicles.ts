/**
 * Public booking vehicle picker: dependent Year → Make → Model lists, and the server-side check that a
 * submitted vehicle came from those lists (customers never type an arbitrary vehicle name).
 *
 * Sources — reuse, never a parallel system:
 *   • Makes: the shop's curated list (apps/vehicle-entry/vehicle-data.ts, also used by Vehicle Entry and the
 *     Estimator) plus brands that are no longer sold but still come in (Pontiac, Saturn, Mercury…), each limited
 *     to the model years it was sold in the US so a year filters the makes.
 *   • Models: NHTSA vPIC GetModelsForMakeYear — the same NHTSA source the VIN decoder uses
 *     (apps/vehicle-entry/vin.ts). Year-accurate. Cached across requests (Next data cache + in-process).
 *     If vPIC is unreachable, car models fall back to the curated list for that make; otherwise the list is
 *     "unavailable" and the customer is pointed to the shop phone.
 *
 * Vehicle types: car (cars, trucks, SUVs, vans), motorcycle and trailer book online — unchanged eligibility,
 * pending an owner decision (2026-10-20). Boats and RVs are "Call to schedule".
 */
import { MAKES as CURATED_MAKES, getModelsForMake } from '@/apps/vehicle-entry/vehicle-data'

export type VehicleType = 'car' | 'motorcycle' | 'trailer'
export type CallOnlyType = 'rv' | 'boat'

export const VEHICLE_TYPES: { key: VehicleType | CallOnlyType; label: string; online: boolean }[] = [
  { key: 'car', label: 'Car, truck, SUV or van', online: true },
  { key: 'motorcycle', label: 'Motorcycle', online: true },
  { key: 'trailer', label: 'Trailer', online: true },
  { key: 'rv', label: 'RV or motorhome', online: false },
  { key: 'boat', label: 'Boat', online: false },
]
export const ONLINE_TYPES: VehicleType[] = ['car', 'motorcycle', 'trailer']
export const isOnlineType = (t: unknown): t is VehicleType => typeof t === 'string' && (ONLINE_TYPES as string[]).includes(t)

export const TRAILER_KINDS = ['Utility trailer', 'Enclosed cargo trailer', 'Car hauler', 'Flatbed / equipment trailer', 'Horse / livestock trailer', 'Dump trailer']

/** 17-character VINs (and NHTSA's model data) start with model year 1981. */
export const OLDEST_YEAR = 1981
/** New model years go on sale the year before (in October 2026, 2027 models are on lots). */
export function yearsFor(now = new Date()): string[] {
  const newest = now.getUTCFullYear() + 1
  return Array.from({ length: newest - OLDEST_YEAR + 1 }, (_, i) => String(newest - i))
}

type Range = [number, number] // inclusive model years; 9999 = still sold
const ALWAYS: Range[] = [[OLDEST_YEAR, 9999]]

/** US model-year ranges for brands that did not exist (or were not sold) for the whole period. */
const MAKE_YEARS: Record<string, Range[]> = {
  'Alfa Romeo': [[1981, 1995], [2014, 9999]], Fiat: [[1981, 1982], [2012, 9999]], Genesis: [[2017, 9999]],
  Lucid: [[2022, 9999]], MINI: [[2002, 9999]], Maserati: [[1981, 1990], [2002, 9999]], Polestar: [[2020, 9999]],
  Ram: [[2011, 9999]], Rivian: [[2022, 9999]], Tesla: [[2008, 9999]], Lexus: [[1990, 9999]], Acura: [[1986, 9999]],
  Infiniti: [[1990, 9999]], Kia: [[1994, 9999]], Hyundai: [[1986, 9999]], 'Land Rover': [[1987, 9999]],
  // No longer sold, still serviced.
  Daewoo: [[1999, 2002]], Eagle: [[1988, 1998]], Geo: [[1989, 1997]], Hummer: [[1992, 2010]], Isuzu: [[1981, 2008]],
  Mercury: [[1981, 2011]], Oldsmobile: [[1981, 2004]], Plymouth: [[1981, 2001]], Pontiac: [[1981, 2010]],
  Saab: [[1981, 2011]], Saturn: [[1991, 2010]], Smart: [[2008, 2019]], Suzuki: [[1985, 2013]],
}
const LEGACY_MAKES = ['Daewoo', 'Eagle', 'Geo', 'Hummer', 'Isuzu', 'Mercury', 'Oldsmobile', 'Plymouth', 'Pontiac', 'Saab', 'Saturn', 'Smart', 'Suzuki']
// Scion is listed by NHTSA under Toyota ("Scion tC", "Scion xB"…), so it is found there, not as its own make.

export const MOTORCYCLE_MAKES = [
  'Aprilia', 'BMW', 'Can-Am', 'Ducati', 'Harley-Davidson', 'Honda', 'Husqvarna', 'Indian', 'Kawasaki', 'KTM',
  'Moto Guzzi', 'Royal Enfield', 'Suzuki', 'Triumph', 'Victory', 'Yamaha', 'Zero',
]
const MOTORCYCLE_YEARS: Record<string, Range[]> = {
  'Can-Am': [[2008, 9999]], Indian: [[1999, 2003], [2009, 9999]], 'Royal Enfield': [[1995, 9999]], Victory: [[1998, 2017]], Zero: [[2008, 9999]],
}

const inRanges = (year: number, ranges: Range[]) => ranges.some(([a, b]) => year >= a && year <= b)
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })

export function makesFor(type: VehicleType, year: string): string[] {
  const y = Number(year)
  if (!Number.isInteger(y) || !yearsFor().includes(year)) return []
  if (type === 'trailer') return []
  if (type === 'motorcycle') return MOTORCYCLE_MAKES.filter((m) => inRanges(y, MOTORCYCLE_YEARS[m] ?? ALWAYS))
  return [...new Set([...CURATED_MAKES, ...LEGACY_MAKES])].filter((m) => inRanges(y, MAKE_YEARS[m] ?? ALWAYS)).sort(byName)
}

export interface ModelList { models: string[]; source: 'nhtsa' | 'fallback' | 'unavailable' | 'fixed' }

const VPIC_TYPES: Record<'car' | 'motorcycle', string[]> = { car: ['car', 'truck', 'mpv'], motorcycle: ['motorcycle'] }
const TTL_MS = 7 * 24 * 3_600_000
const memo = new Map<string, { at: number; list: string[] }>()

async function vpicModels(make: string, year: string, vtype: string, fetchImpl: typeof fetch): Promise<string[]> {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}/vehicletype/${vtype}?format=json`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(6_000), next: { revalidate: 30 * 24 * 3600 } } as RequestInit)
  if (!res.ok) throw new Error(`NHTSA ${res.status}`)
  const body = await res.json() as { Results?: { Model_Name?: string }[] }
  return (body.Results ?? []).map((r) => (r.Model_Name ?? '').trim()).filter((n) => n && n.length <= 100)
}

/** Models for one year + make. Never throws: an outage returns `fallback` or `unavailable`. */
export async function modelsFor(type: VehicleType, year: string, make: string, opts: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<ModelList> {
  if (type === 'trailer') return { models: [...TRAILER_KINDS], source: 'fixed' }
  if (!makesFor(type, year).includes(make)) return { models: [], source: 'fixed' }
  const key = `${type}|${year}|${make}`
  const now = opts.now ?? Date.now()
  const hit = memo.get(key)
  if (hit && now - hit.at < TTL_MS) return { models: hit.list, source: 'nhtsa' }
  try {
    const lists = await Promise.all(VPIC_TYPES[type].map((t) => vpicModels(make, year, t, opts.fetchImpl ?? fetch)))
    const list = [...new Set(lists.flat())].sort(byName)
    memo.set(key, { at: now, list })
    if (memo.size > 2000) memo.delete(memo.keys().next().value as string)
    return { models: list, source: 'nhtsa' }
  } catch (err) {
    console.error('[book] NHTSA model list unavailable:', err instanceof Error ? err.message : err)
    const fallback = type === 'car' ? getModelsForMake(make) : []
    return fallback.length ? { models: [...fallback].sort(byName), source: 'fallback' } : { models: [], source: 'unavailable' }
  }
}

export interface VehicleChoice { type: string; year: string; make: string; model: string }

/** Server-side: the submitted vehicle must come from the same lists the customer was shown. */
export async function validateVehicle(v: VehicleChoice, opts: { fetchImpl?: typeof fetch } = {}): Promise<string | null> {
  if (!isOnlineType(v.type)) return 'Choose your vehicle type. Boats and RVs are scheduled by phone.'
  if (!yearsFor().includes(v.year)) return 'Choose the vehicle year from the list.'
  if (v.type === 'trailer') return TRAILER_KINDS.includes(v.model) ? null : 'Choose the trailer type from the list.'
  if (!makesFor(v.type, v.year).includes(v.make)) return 'Choose the make from the list.'
  const list = await modelsFor(v.type, v.year, v.make, opts)
  if (list.source === 'unavailable') return 'We could not check the vehicle list right now. Please try again in a minute, or call the shop.'
  return list.models.includes(v.model) ? null : 'Choose the model from the list.'
}

/** Test hook. */
export function clearVehicleCache() { memo.clear() }

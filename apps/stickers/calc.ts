/**
 * Oil-change sticker calculations — pure, client-safe (no DB, no server imports).
 *
 * The shop never assumes one interval fits every vehicle: the interval (miles and/or months)
 * is chosen per sticker in the form, and both computed next-service values can be manually
 * overridden before printing. These helpers only do the arithmetic.
 */
export const BUSINESS_TIME_ZONE = 'America/Chicago'

/** YYYY-MM-DD for `now` in the shop's (US Central) time zone. */
export function businessToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM-DD' → 'Feb 25, 2027' (as printed on the sticker). Returns null for bad input. */
export function formatStickerDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  if (!m) return null
  const [, y, mo, d] = m
  const month = MONTHS[parseInt(mo, 10) - 1]
  if (!month) return null
  return `${month} ${parseInt(d, 10)}, ${y}`
}

/** 192781 → '192,781 mi'. */
export function formatMiles(n: number): string {
  return `${Math.trunc(n).toLocaleString('en-US')} mi`
}

/**
 * Add calendar months to an ISO date, clamping to the last day of the target month
 * (Jan 31 + 1 month → Feb 28/29). Pure date math — no time zones involved.
 */
export function addMonthsClamped(iso: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new Error(`bad date: ${iso}`)
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10)
  const total = y * 12 + mo + months
  const ty = Math.floor(total / 12), tm = total % 12
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  const td = Math.min(d, lastDay)
  return `${String(ty).padStart(4, '0')}-${String(tm + 1).padStart(2, '0')}-${String(td).padStart(2, '0')}`
}

export interface NextService { nextMileage: number | null; nextDate: string | null }

/** Computed next-service values from current mileage + the chosen interval. */
export function computeNextService(input: {
  mileage: number | null
  intervalMiles: number | null
  intervalMonths: number | null
  today?: string
}): NextService {
  const today = input.today ?? businessToday()
  const nextMileage = input.mileage != null && input.intervalMiles != null ? input.mileage + input.intervalMiles : null
  const nextDate = input.intervalMonths != null ? addMonthsClamped(today, input.intervalMonths) : null
  return { nextMileage, nextDate }
}

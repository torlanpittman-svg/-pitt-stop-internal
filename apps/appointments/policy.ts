/**
 * Booking rules — PURE (no DB, no network). Everything availability depends on lives here so it can be
 * tested exhaustively: shop-local time (America/Chicago incl. DST), the online drop-off window
 * (default Mon–Fri 7:15–11:00 AM inclusive), same-day lead time, booking horizon, actual-date federal
 * holidays (no observed-day shifting — owner decision 2026-10-15), manager closures, and capacity.
 *
 * The appointment time is the customer's DROP-OFF time only — not when work starts, not a bay or a
 * technician. So capacity only spaces arrivals apart (owner decision 2026-10-19):
 *
 *   • slotCapacity          — public drop-offs per time (default 1: one customer per 15-minute time)
 *   • dailyAppointmentLimit — optional cap on bookings per day (default null = unlimited)
 *   • workload limits       — dailyUnits / categoryLimits with per-service weights. Kept for later but
 *                             OFF by default (workloadLimitsEnabled=false); while off, weights have no
 *                             effect on availability.
 *
 * Displayed availability is informational — the atomic insert in db.ts re-checks capacity under a per-day
 * lock, so two customers can never take the same time.
 */

export type ServiceCategory = 'detail' | 'mechanic'
export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface BookingService {
  key: string
  label: string
  description: string
  category: ServiceCategory
  /** Workload units this service uses from the day's capacity. */
  weight: number
  /** Optional canonical catalog slug used when the appointment is checked in (null = staff chooses). */
  catalogSlug: string | null
  enabled: boolean
}

export interface DayHours { open: boolean; start: string; cutoff: string }

export interface BookingConfig {
  /** Public online booking switch (staff can always enter appointments). */
  enabled: boolean
  timezone: string
  intervalMinutes: number
  sameDayEnabled: boolean
  /** Minimum minutes between "now" and a same-day drop-off time. */
  sameDayLeadMinutes: number
  maxAdvanceDays: number
  days: Record<Weekday, DayHours>
  federalHolidaysClosed: boolean
  /** Public drop-offs allowed per time. */
  slotCapacity: number | null
  /** Optional cap on active bookings per day; null = unlimited. */
  dailyAppointmentLimit: number | null
  /** When false (default), dailyUnits / categoryLimits / service weights do not affect availability. */
  workloadLimitsEnabled: boolean
  dailyUnits: number | null
  categoryLimits: Record<ServiceCategory, number | null>
  /** Customers may cancel online until this many minutes before the drop-off time. */
  cancelCutoffMinutes: number
  confirmationEnabled: boolean
  reminderEnabled: boolean
  reminderHoursBefore: number
  services: BookingService[]
  title: string
  intro: string
  phone: string
  address: string
  instructions: string
  cancellationPolicy: string
}

const weekday = (open: boolean): DayHours => ({ open, start: '07:15', cutoff: '11:00' })

export const DEFAULT_BOOKING_SERVICES: BookingService[] = [
  { key: 'complete_detail', label: 'Complete Detail', description: 'Interior and exterior.', category: 'detail', weight: 1, catalogSlug: 'complete_detail', enabled: true },
  { key: 'interior_detail', label: 'Interior Detail', description: 'Seats, carpets, surfaces, stains.', category: 'detail', weight: 1, catalogSlug: 'interior_detail', enabled: true },
  { key: 'exterior_detail', label: 'Exterior Detail', description: 'Wash and exterior care.', category: 'detail', weight: 1, catalogSlug: null, enabled: true },
  { key: 'mini_detail', label: 'Mini Detail', description: 'A lighter refresh, inside and out.', category: 'detail', weight: 1, catalogSlug: 'mini_detail', enabled: true },
  { key: 'paint_correction', label: 'Paint Correction', description: 'Swirl and scratch removal. Final scope confirmed at drop-off.', category: 'detail', weight: 2, catalogSlug: null, enabled: true },
  { key: 'ceramic_coating', label: 'Ceramic Coating', description: '1-year or 3-year coating. We confirm the option with you at drop-off.', category: 'detail', weight: 2, catalogSlug: null, enabled: true },
  { key: 'odor', label: 'Odor / Ozone', description: 'Smoke, pet and odor treatment.', category: 'detail', weight: 1, catalogSlug: null, enabled: true },
  { key: 'mechanic', label: 'Mechanic / Repair', description: 'Drop off for an assessment. Repairs and pricing are agreed with you first.', category: 'mechanic', weight: 1, catalogSlug: null, enabled: true },
  { key: 'other', label: 'Other / Need a Recommendation', description: 'Tell us what you need and we will recommend the right service.', category: 'detail', weight: 1, catalogSlug: null, enabled: true },
]

export const DEFAULT_BOOKING_CONFIG: BookingConfig = {
  enabled: false,
  timezone: 'America/Chicago',
  intervalMinutes: 15,
  sameDayEnabled: true,
  sameDayLeadMinutes: 60,
  maxAdvanceDays: 30,
  days: { sun: weekday(false), mon: weekday(true), tue: weekday(true), wed: weekday(true), thu: weekday(true), fri: weekday(true), sat: weekday(false) },
  federalHolidaysClosed: true,
  slotCapacity: 1,
  dailyAppointmentLimit: null,
  workloadLimitsEnabled: false,
  dailyUnits: null,
  categoryLimits: { detail: null, mechanic: null },
  cancelCutoffMinutes: 60,
  confirmationEnabled: true,
  reminderEnabled: true,
  reminderHoursBefore: 24,
  services: DEFAULT_BOOKING_SERVICES,
  title: 'Book a drop-off',
  intro: 'Pick a drop-off time. Your appointment is confirmed right away.',
  phone: '(979) 696-6640',
  address: '3112 Texas Ave S, College Station, TX 77845',
  instructions: 'Please remove valuables and personal items before drop-off. Your drop-off time is when we receive the vehicle, not a promised finish time. We will contact you when it is ready.',
  cancellationPolicy: 'Need to cancel? Use your appointment link up to 1 hour before drop-off, or call the shop. To change the time, call the shop.',
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const posIntOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}
const intIn = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isInteger(n) && n >= lo && n <= hi ? n : d
}
const str = (v: unknown, d: string, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

/** Merge a stored (possibly partial / hand-edited) config onto the defaults. Never throws. */
export function mergeBookingConfig(raw: unknown): BookingConfig {
  const r = (raw && typeof raw === 'object' ? raw : typeof raw === 'string' ? safeJson(raw) : {}) as Record<string, unknown>
  const d = DEFAULT_BOOKING_CONFIG
  const rd = (r.days && typeof r.days === 'object' ? r.days : {}) as Record<string, Partial<DayHours>>
  const days = Object.fromEntries(WEEKDAYS.map((w) => {
    const x = rd[w] ?? {}
    return [w, {
      open: bool(x.open, d.days[w].open),
      start: typeof x.start === 'string' && HHMM.test(x.start) ? x.start : d.days[w].start,
      cutoff: typeof x.cutoff === 'string' && HHMM.test(x.cutoff) ? x.cutoff : d.days[w].cutoff,
    }]
  })) as Record<Weekday, DayHours>
  const cl = (r.categoryLimits && typeof r.categoryLimits === 'object' ? r.categoryLimits : {}) as Record<string, unknown>
  const services = Array.isArray(r.services) && r.services.length
    ? (r.services as Partial<BookingService>[]).filter((s) => s && typeof s.key === 'string' && typeof s.label === 'string').map((s) => ({
        key: String(s.key).slice(0, 40), label: String(s.label).slice(0, 80), description: str(s.description, '', 240),
        category: (s.category === 'mechanic' ? 'mechanic' : 'detail') as ServiceCategory,
        weight: intIn(s.weight, 0, 20, 1), catalogSlug: typeof s.catalogSlug === 'string' && s.catalogSlug ? s.catalogSlug : null,
        enabled: bool(s.enabled, true),
      }))
    : d.services
  return {
    enabled: bool(r.enabled, d.enabled),
    timezone: typeof r.timezone === 'string' && validTimeZone(r.timezone) ? r.timezone : d.timezone,
    intervalMinutes: [5, 10, 15, 20, 30, 60].includes(Number(r.intervalMinutes)) ? Number(r.intervalMinutes) : d.intervalMinutes,
    sameDayEnabled: bool(r.sameDayEnabled, d.sameDayEnabled),
    sameDayLeadMinutes: intIn(r.sameDayLeadMinutes, 0, 24 * 60, d.sameDayLeadMinutes),
    maxAdvanceDays: intIn(r.maxAdvanceDays, 1, 365, d.maxAdvanceDays),
    days,
    federalHolidaysClosed: bool(r.federalHolidaysClosed, d.federalHolidaysClosed),
    slotCapacity: 'slotCapacity' in r ? posIntOrNull(r.slotCapacity) : d.slotCapacity,
    dailyAppointmentLimit: 'dailyAppointmentLimit' in r ? posIntOrNull(r.dailyAppointmentLimit) : d.dailyAppointmentLimit,
    workloadLimitsEnabled: bool(r.workloadLimitsEnabled, d.workloadLimitsEnabled),
    dailyUnits: 'dailyUnits' in r ? posIntOrNull(r.dailyUnits) : d.dailyUnits,
    categoryLimits: { detail: posIntOrNull(cl.detail), mechanic: posIntOrNull(cl.mechanic) },
    cancelCutoffMinutes: intIn(r.cancelCutoffMinutes, 0, 7 * 24 * 60, d.cancelCutoffMinutes),
    confirmationEnabled: bool(r.confirmationEnabled, d.confirmationEnabled),
    reminderEnabled: bool(r.reminderEnabled, d.reminderEnabled),
    reminderHoursBefore: intIn(r.reminderHoursBefore, 1, 7 * 24, d.reminderHoursBefore),
    services,
    title: str(r.title, d.title, 120), intro: str(r.intro, d.intro, 500), phone: str(r.phone, d.phone, 40),
    address: str(r.address, d.address, 200), instructions: str(r.instructions, d.instructions),
    cancellationPolicy: str(r.cancellationPolicy, d.cancellationPolicy),
  }
}

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return {} } }
function validTimeZone(tz: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }

/** Public booking may only run with a per-time drop-off limit (and workload numbers, if workload limits are on). */
export function bookingReadiness(cfg: BookingConfig): { ready: boolean; missing: string[] } {
  const missing: string[] = []
  if (cfg.slotCapacity == null) missing.push('Public drop-offs per time')
  if (cfg.workloadLimitsEnabled && cfg.dailyUnits == null && cfg.categoryLimits.detail == null && cfg.categoryLimits.mechanic == null) {
    missing.push('Workload limit numbers (or turn workload limits off)')
  }
  if (!cfg.services.some((s) => s.enabled)) missing.push('At least one online service')
  if (!WEEKDAYS.some((w) => cfg.days[w].open)) missing.push('At least one open day')
  return { ready: missing.length === 0, missing }
}

export function publicBookingOpen(cfg: BookingConfig): boolean {
  return cfg.enabled && bookingReadiness(cfg).ready
}

// ── Shop-local time ───────────────────────────────────────────────────────────

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
export const isHHMM = (s: string) => HHMM.test(s)
export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/** Offset (ms) of `tz` from UTC at `instant`: local wall-clock as-if-UTC minus the instant. */
function tzOffsetMs(instant: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(instant)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a }, {})
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant / 1000) * 1000
}

/** The UTC instant of a shop-local date + HH:MM (DST-correct). */
export function zonedToUtc(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)))
  let t = guess - tzOffsetMs(guess, tz)
  t = guess - tzOffsetMs(t, tz)
  return new Date(t)
}

/** Shop-local date (YYYY-MM-DD) and minutes-after-midnight of an instant. */
export function localParts(instant: Date, tz: string): { date: string; minutes: number } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(instant).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a }, {})
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}

export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}
export const weekdayOf = (date: string): Weekday => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]

// ── Federal holidays (ACTUAL date, never the observed Friday/Monday) ──────────

function nthWeekday(year: number, month: number, dow: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
function lastWeekday(year: number, month: number, dow: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
  const day = lastDay - ((lastDow - dow + 7) % 7)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The 11 recurring nationwide federal holidays for a year, keyed by actual date. */
export function federalHolidays(year: number): Map<string, string> {
  const f = (m: number, d: number) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return new Map([
    [f(1, 1), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'],
    [nthWeekday(year, 2, 1, 3), "Washington's Birthday"],
    [lastWeekday(year, 5, 1), 'Memorial Day'],
    [f(6, 19), 'Juneteenth'],
    [f(7, 4), 'Independence Day'],
    [nthWeekday(year, 9, 1, 1), 'Labor Day'],
    [nthWeekday(year, 10, 1, 2), 'Columbus Day'],
    [f(11, 11), 'Veterans Day'],
    [nthWeekday(year, 11, 4, 4), 'Thanksgiving Day'],
    [f(12, 25), 'Christmas Day'],
  ])
}
export function holidayName(date: string): string | null {
  return federalHolidays(Number(date.slice(0, 4))).get(date) ?? null
}

// ── Services → workload units ─────────────────────────────────────────────────

export interface Need { detail: number; mechanic: number }

/** Resolve chosen service keys against the config. Unknown/disabled keys are rejected (publicOnly). */
export function resolveServices(cfg: BookingConfig, keys: string[], opts: { publicOnly: boolean }):
  { ok: true; services: BookingService[]; need: Need; labels: string } | { ok: false; error: string } {
  const uniq = [...new Set(keys.map((k) => String(k)))].slice(0, 12)
  if (!uniq.length) return { ok: false, error: 'Choose at least one service.' }
  const services: BookingService[] = []
  for (const k of uniq) {
    const s = cfg.services.find((x) => x.key === k)
    if (!s || (opts.publicOnly && !s.enabled)) return { ok: false, error: 'That service is not available online. Please call the shop.' }
    services.push(s)
  }
  const need: Need = { detail: 0, mechanic: 0 }
  for (const s of services) need[s.category] += s.weight
  return { ok: true, services, need, labels: services.map((s) => s.label).join(', ') }
}

// ── Availability ──────────────────────────────────────────────────────────────

export interface BookedLoad { localDate: string; localTime: string; unitsDetail: number; unitsMechanic: number }
export interface Block { kind: 'close' | 'open'; localDate: string; localTime: string | null; reason: string | null }

export interface SlotView { time: string; available: boolean; reason?: 'past' | 'lead_time' | 'full' | 'blocked' }
export interface DayView { date: string; weekday: Weekday; closed: boolean; closedReason?: string; slots: SlotView[] }

export function slotTimes(hours: DayHours, intervalMinutes: number): string[] {
  const out: string[] = []
  for (let m = toMinutes(hours.start); m <= toMinutes(hours.cutoff); m += intervalMinutes) out.push(fromMinutes(m))
  return out
}

/** Why a whole date cannot take public bookings, or null when it can. */
export function dateClosedReason(cfg: BookingConfig, date: string, now: Date, blocks: Block[]): string | null {
  const today = localParts(now, cfg.timezone).date
  if (date < today) return 'Past date'
  if (date > addDays(today, cfg.maxAdvanceDays)) return 'Too far ahead'
  if (date === today && !cfg.sameDayEnabled) return 'Same-day booking is off'
  const dayBlocks = blocks.filter((b) => b.localDate === date && b.localTime == null)
  if (dayBlocks.some((b) => b.kind === 'close')) return dayBlocks.find((b) => b.kind === 'close')?.reason || 'Closed'
  const reopened = dayBlocks.some((b) => b.kind === 'open')
  if (!cfg.days[weekdayOf(date)].open && !reopened) return 'Closed'
  const holiday = cfg.federalHolidaysClosed ? holidayName(date) : null
  if (holiday && !reopened) return holiday
  return null
}

/** Capacity left check for one date/time against existing active bookings (excluding `excludeId` loads). */
export function capacityAllows(cfg: BookingConfig, loads: BookedLoad[], date: string, time: string, need: Need): boolean {
  const day = loads.filter((l) => l.localDate === date)
  if (cfg.slotCapacity != null && day.filter((l) => l.localTime === time).length >= cfg.slotCapacity) return false
  if (cfg.dailyAppointmentLimit != null && day.length >= cfg.dailyAppointmentLimit) return false
  if (!cfg.workloadLimitsEnabled) return true
  const usedD = day.reduce((s, l) => s + l.unitsDetail, 0)
  const usedM = day.reduce((s, l) => s + l.unitsMechanic, 0)
  if (cfg.dailyUnits != null && usedD + usedM + need.detail + need.mechanic > cfg.dailyUnits) return false
  if (cfg.categoryLimits.detail != null && need.detail > 0 && usedD + need.detail > cfg.categoryLimits.detail) return false
  if (cfg.categoryLimits.mechanic != null && need.mechanic > 0 && usedM + need.mechanic > cfg.categoryLimits.mechanic) return false
  return true
}

/** Public/staff availability for a range of dates. `loads` must be ACTIVE bookings only. */
export function computeAvailability(input: {
  cfg: BookingConfig; now: Date; fromDate: string; days: number; loads: BookedLoad[]; blocks: Block[]; need: Need
}): DayView[] {
  const { cfg, now, loads, blocks, need } = input
  const nowMs = now.getTime()
  const out: DayView[] = []
  for (let i = 0; i < input.days; i++) {
    const date = addDays(input.fromDate, i)
    const wd = weekdayOf(date)
    const closedReason = dateClosedReason(cfg, date, now, blocks)
    if (closedReason) { out.push({ date, weekday: wd, closed: true, closedReason, slots: [] }); continue }
    const timeBlocks = new Set(blocks.filter((b) => b.localDate === date && b.localTime && b.kind === 'close').map((b) => b.localTime as string))
    const slots: SlotView[] = slotTimes(cfg.days[wd], cfg.intervalMinutes).map((time) => {
      const at = zonedToUtc(date, time, cfg.timezone).getTime()
      if (at <= nowMs) return { time, available: false, reason: 'past' as const }
      if (at < nowMs + cfg.sameDayLeadMinutes * 60_000) return { time, available: false, reason: 'lead_time' as const }
      if (timeBlocks.has(time)) return { time, available: false, reason: 'blocked' as const }
      if (!capacityAllows(cfg, loads, date, time, need)) return { time, available: false, reason: 'full' as const }
      return { time, available: true }
    })
    out.push({ date, weekday: wd, closed: false, slots })
  }
  return out
}

/** Server-side validation of one requested public slot (before the atomic capacity-checked insert). */
export function validatePublicSlot(cfg: BookingConfig, date: string, time: string, now: Date, blocks: Block[]): string | null {
  if (!isIsoDate(date) || !isHHMM(time)) return 'Choose a valid date and time.'
  const closed = dateClosedReason(cfg, date, now, blocks)
  if (closed) return 'That day is not available for online booking.'
  const times = slotTimes(cfg.days[weekdayOf(date)], cfg.intervalMinutes)
  if (!times.includes(time)) return 'That time is not available for online booking.'
  const at = zonedToUtc(date, time, cfg.timezone).getTime()
  if (at < now.getTime() + cfg.sameDayLeadMinutes * 60_000) return 'That time has passed or is too soon. Please pick a later time.'
  if (blocks.some((b) => b.localDate === date && b.localTime === time && b.kind === 'close')) return 'That time is not available.'
  return null
}

/** Shop-local friendly labels. */
export function formatDateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}
export function formatTimeLabel(hhmm: string): string {
  const m = toMinutes(hhmm); const h = Math.floor(m / 60); const mm = m % 60
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

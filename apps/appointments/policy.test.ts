import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOOKING_CONFIG, mergeBookingConfig, bookingReadiness, publicBookingOpen, computeAvailability, validatePublicSlot,
  zonedToUtc, localParts, slotTimes, federalHolidays, holidayName, resolveServices, capacityAllows, type BookingConfig, type BookedLoad,
} from './policy'

const TZ = 'America/Chicago'
/** The launch configuration (owner decision 2026-10-19) with online booking switched on. */
const cfg = (over: Partial<BookingConfig> = {}): BookingConfig => ({ ...DEFAULT_BOOKING_CONFIG, enabled: true, ...over })
/** A shop-local wall-clock instant. */
const at = (date: string, hhmm: string) => zonedToUtc(date, hhmm, TZ)
const one = { detail: 1, mechanic: 0 }
const avail = (c: BookingConfig, now: Date, fromDate: string, loads: BookedLoad[] = [], blocks: Parameters<typeof computeAvailability>[0]['blocks'] = [], days = 1) =>
  computeAvailability({ cfg: c, now, fromDate, days, loads, blocks, need: one })
const openTimes = (d: ReturnType<typeof avail>[number]) => d.slots.filter((s) => s.available).map((s) => s.time)

// Monday 2026-10-19 is a normal weekday; 2026-10-12 was Columbus Day.
const MON = '2026-10-19'
const TUE = '2026-10-20'

describe('drop-off window and cutoff', () => {
  it('offers 7:15 through 11:00 inclusive every 15 minutes (16 choices) and nothing after the cutoff', () => {
    const times = slotTimes(DEFAULT_BOOKING_CONFIG.days.mon, 15)
    expect(times).toHaveLength(16)
    expect(times[0]).toBe('07:15')
    expect(times.at(-1)).toBe('11:00')
    const [day] = avail(cfg(), at(MON, '06:00'), TUE)
    expect(openTimes(day).at(-1)).toBe('11:00')
    expect(day.slots.some((s) => s.time > '11:00')).toBe(false)
  })

  it('the cutoff is configurable', () => {
    const c = cfg({ days: { ...DEFAULT_BOOKING_CONFIG.days, tue: { open: true, start: '08:00', cutoff: '10:00' } }, intervalMinutes: 30 })
    expect(openTimes(avail(c, at(MON, '06:00'), TUE)[0])).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00'])
  })

  it('rejects a public request for 11:15 or 7:00 server-side', () => {
    expect(validatePublicSlot(cfg(), TUE, '11:15', at(MON, '06:00'), [])).toMatch(/not available/)
    expect(validatePublicSlot(cfg(), TUE, '07:00', at(MON, '06:00'), [])).toMatch(/not available/)
    expect(validatePublicSlot(cfg(), TUE, '11:00', at(MON, '06:00'), [])).toBeNull()
  })
})

describe('same-day booking', () => {
  it('at 8:10 AM with a 60-minute lead, today still offers 9:15 → 11:00', () => {
    const [day] = avail(cfg(), at(MON, '08:10'), MON)
    expect(day.closed).toBe(false)
    expect(openTimes(day)[0]).toBe('09:15')
    expect(openTimes(day).at(-1)).toBe('11:00')
    expect(day.slots.find((s) => s.time === '08:00')?.reason).toBe('past')
    expect(day.slots.find((s) => s.time === '09:00')?.reason).toBe('lead_time')
  })

  it('with no lead time, the next quarter-hour is bookable', () => {
    expect(openTimes(avail(cfg({ sameDayLeadMinutes: 0 }), at(MON, '08:10'), MON)[0])[0]).toBe('08:15')
  })

  it('past slots are excluded; after the cutoff today has nothing left', () => {
    const [day] = avail(cfg(), at(MON, '11:30'), MON)
    expect(openTimes(day)).toEqual([])
    expect(day.slots.every((s) => s.reason === 'past')).toBe(true)
  })

  it('same-day can be switched off', () => {
    expect(avail(cfg({ sameDayEnabled: false }), at(MON, '07:00'), MON)[0].closed).toBe(true)
  })
})

describe('closed days, holidays and blocks', () => {
  it('weekends are closed by default', () => {
    const days = avail(cfg(), at(MON, '06:00'), '2026-10-24', [], [], 2)
    expect(days.map((d) => d.closed)).toEqual([true, true])
  })

  it('closes federal holidays on their ACTUAL date only (no observed Friday/Monday)', () => {
    expect(holidayName('2026-09-07')).toBe('Labor Day')
    expect(holidayName('2026-11-26')).toBe('Thanksgiving Day')
    expect(holidayName('2026-07-03')).toBeNull() // Friday before a Saturday July 4 stays open
    expect(holidayName('2027-12-24')).toBeNull() // Friday before a Saturday Christmas stays open
    expect(holidayName('2027-07-05')).toBeNull() // Monday after a Sunday July 4 stays open
    expect(federalHolidays(2026).size).toBe(11)
    const thanksgiving = avail(cfg(), at('2026-11-20', '06:00'), '2026-11-26')[0]
    expect(thanksgiving.closed).toBe(true)
    expect(thanksgiving.closedReason).toBe('Thanksgiving Day')
  })

  it('a manager can deliberately re-open a holiday', () => {
    const d = avail(cfg(), at('2026-11-20', '06:00'), '2026-11-26', [], [{ kind: 'open', localDate: '2026-11-26', localTime: null, reason: null }])[0]
    expect(d.closed).toBe(false)
  })

  it('a whole-day block closes the date; a time block removes one slot', () => {
    const closedDay = avail(cfg(), at(MON, '06:00'), TUE, [], [{ kind: 'close', localDate: TUE, localTime: null, reason: 'Staff training' }])[0]
    expect(closedDay.closed).toBe(true)
    expect(closedDay.closedReason).toBe('Staff training')
    const oneSlot = avail(cfg(), at(MON, '06:00'), TUE, [], [{ kind: 'close', localDate: TUE, localTime: '09:00', reason: null }])[0]
    expect(oneSlot.slots.find((s) => s.time === '09:00')).toMatchObject({ available: false, reason: 'blocked' })
    expect(oneSlot.slots.find((s) => s.time === '09:15')?.available).toBe(true)
  })

  it('dates beyond the booking horizon are closed', () => {
    expect(avail(cfg({ maxAdvanceDays: 7 }), at(MON, '06:00'), '2026-10-27')[0].closed).toBe(true)
  })
})

describe('capacity — drop-off spacing (launch model)', () => {
  const load = (time: string, d = 1, m = 0): BookedLoad => ({ localDate: TUE, localTime: time, unitsDetail: d, unitsMechanic: m })
  const ALL = slotTimes(DEFAULT_BOOKING_CONFIG.days.tue, 15)

  it('launch defaults: 1 public drop-off per time, 15-minute spacing, no daily cap, workload limits off', () => {
    const d = DEFAULT_BOOKING_CONFIG
    expect(d.slotCapacity).toBe(1)
    expect(d.intervalMinutes).toBe(15)
    expect(d.dailyAppointmentLimit).toBeNull()
    expect(d.workloadLimitsEnabled).toBe(false)
    expect(d.dailyUnits).toBeNull()
    expect(d.sameDayEnabled).toBe(true)
    expect(d.sameDayLeadMinutes).toBe(60)
    expect(d.enabled).toBe(false) // public booking still ships OFF until a manager turns it on
    expect(bookingReadiness(mergeBookingConfig({ enabled: true })).ready).toBe(true)
    expect(publicBookingOpen(mergeBookingConfig({ enabled: true }))).toBe(true)
  })

  it('a booked time is no longer offered; the next 15-minute time still is', () => {
    const [day] = avail(cfg(), at(MON, '06:00'), TUE, [load('08:30')])
    expect(day.slots.find((s) => s.time === '08:30')).toMatchObject({ available: false, reason: 'full' })
    expect(day.slots.find((s) => s.time === '08:45')?.available).toBe(true)
    expect(day.slots.find((s) => s.time === '08:15')?.available).toBe(true)
  })

  it('many bookings in a day never close the day — every unbooked time stays open', () => {
    const booked = ALL.filter((_, i) => i % 2 === 0) // 8 bookings
    const [day] = avail(cfg(), at(MON, '06:00'), TUE, booked.map((t) => load(t)))
    expect(day.closed).toBe(false)
    expect(openTimes(day)).toEqual(ALL.filter((t) => !booked.includes(t)))
    // 15 of 16 taken: the last one is still bookable
    const [nearlyFull] = avail(cfg(), at(MON, '06:00'), TUE, ALL.slice(0, 15).map((t) => load(t)))
    expect(openTimes(nearlyFull)).toEqual(['11:00'])
  })

  it('ceramic coating at 8:00 takes only 8:00 — 8:15, 8:30 and every later open time remain', () => {
    const ceramic = resolveServices(cfg(), ['ceramic_coating'], { publicOnly: true })
    expect(ceramic.ok && ceramic.need.detail).toBe(2) // weight is still stored…
    const [day] = avail(cfg(), at(MON, '06:00'), TUE, [load('08:00', 2)])
    expect(openTimes(day)).toEqual(ALL.filter((t) => t !== '08:00')) // …but closes nothing else
  })

  it('paint correction does not remove unrelated later times either', () => {
    const [day] = avail(cfg(), at(MON, '06:00'), TUE, [load('07:15', 2), load('09:00', 2), load('10:00', 2)])
    expect(openTimes(day)).toEqual(ALL.filter((t) => !['07:15', '09:00', '10:00'].includes(t)))
  })

  it('service weights have no effect while workload limits are off, even if unit numbers are stored', () => {
    const c = cfg({ dailyUnits: 3, categoryLimits: { detail: 1, mechanic: 1 } })
    const heavy = [load('07:15', 2), load('07:30', 2), load('07:45', 0, 2)]
    expect(capacityAllows(c, heavy, TUE, '09:00', { detail: 2, mechanic: 0 })).toBe(true)
    expect(capacityAllows(c, heavy, TUE, '09:15', { detail: 0, mechanic: 2 })).toBe(true)
  })

  it('daily capacity stays unlimited until a manager explicitly sets a limit', () => {
    const loads = ALL.slice(0, 10).map((t) => load(t))
    expect(capacityAllows(cfg(), loads, TUE, '11:00', one)).toBe(true)
    const capped = cfg({ dailyAppointmentLimit: 10 })
    expect(capacityAllows(capped, loads, TUE, '11:00', one)).toBe(false)
    expect(capacityAllows(cfg({ dailyAppointmentLimit: 11 }), loads, TUE, '11:00', one)).toBe(true)
  })

  it('workload limits still work when a manager turns them on (kept for later)', () => {
    const c = cfg({ workloadLimitsEnabled: true, dailyUnits: 3 })
    const loads = [load('08:00', 2)]
    expect(capacityAllows(c, loads, TUE, '09:00', { detail: 1, mechanic: 0 })).toBe(true)
    expect(capacityAllows(c, loads, TUE, '09:00', { detail: 2, mechanic: 0 })).toBe(false)
    const cat = cfg({ workloadLimitsEnabled: true, dailyUnits: 10, categoryLimits: { detail: null, mechanic: 1 } })
    expect(capacityAllows(cat, [load('08:00', 0, 1)], TUE, '09:00', { detail: 0, mechanic: 1 })).toBe(false)
    expect(capacityAllows(cat, [load('08:00', 0, 1)], TUE, '09:00', { detail: 1, mechanic: 0 })).toBe(true)
    // turning them on without numbers keeps public booking off instead of guessing a cap
    expect(bookingReadiness(cfg({ workloadLimitsEnabled: true })).ready).toBe(false)
  })

  it('a stored per-time limit of 2 allows two drop-offs at one time', () => {
    const [day] = avail(cfg({ slotCapacity: 2 }), at(MON, '06:00'), TUE, [load('08:00')])
    expect(day.slots.find((s) => s.time === '08:00')?.available).toBe(true)
  })

  it('the spacing is configurable (30 minutes)', () => {
    expect(openTimes(avail(cfg({ intervalMinutes: 30 }), at(MON, '06:00'), TUE)[0]))
      .toEqual(['07:15', '07:45', '08:15', '08:45', '09:15', '09:45', '10:15', '10:45'])
  })

  it('a missing per-time limit keeps public booking OFF', () => {
    expect(publicBookingOpen(mergeBookingConfig({ enabled: true, slotCapacity: null }))).toBe(false)
  })
})

describe('time zone', () => {
  it('converts shop-local times correctly on both sides of the November DST change', () => {
    expect(at('2026-10-30', '08:00').toISOString()).toBe('2026-10-30T13:00:00.000Z') // CDT, UTC-5
    expect(at('2026-11-02', '08:00').toISOString()).toBe('2026-11-02T14:00:00.000Z') // CST, UTC-6
    expect(localParts(new Date('2026-11-02T14:00:00Z'), TZ)).toEqual({ date: '2026-11-02', minutes: 480 })
  })
})

describe('services and config', () => {
  it('rejects unknown or disabled services for public booking, sums weights per category', () => {
    const c = cfg()
    expect(resolveServices(c, ['nope'], { publicOnly: true }).ok).toBe(false)
    const disabled = { ...c, services: c.services.map((s) => (s.key === 'mechanic' ? { ...s, enabled: false } : s)) }
    expect(resolveServices(disabled, ['mechanic'], { publicOnly: true }).ok).toBe(false)
    expect(resolveServices(disabled, ['mechanic'], { publicOnly: false }).ok).toBe(true)
    const r = resolveServices(c, ['complete_detail', 'ceramic_coating', 'mechanic'], { publicOnly: true })
    expect(r.ok && r.need).toEqual({ detail: 3, mechanic: 1 })
  })

  it('a hand-edited / partial config never throws and keeps safe defaults', () => {
    const c = mergeBookingConfig('{"intervalMinutes": 7, "days": {"mon": {"cutoff": "25:00"}}, "slotCapacity": -3, "timezone": "Mars/Base"}')
    expect(c.intervalMinutes).toBe(15)
    expect(c.days.mon.cutoff).toBe('11:00')
    expect(c.slotCapacity).toBeNull()
    expect(c.timezone).toBe(TZ)
    expect(mergeBookingConfig('not json').enabled).toBe(false)
  })
})

describe('service names + defaults added later', () => {
  it('defaults use the website package names and keep stable keys', async () => {
    const { DEFAULT_BOOKING_SERVICES } = await import('./policy')
    const byKey = Object.fromEntries(DEFAULT_BOOKING_SERVICES.map((s) => [s.key, s.label]))
    expect(byKey).toMatchObject({ mini_detail: 'Mini Detail', complete_detail: 'Full Detail', premium_detail: 'Premium Detail', ceramic_coating: 'Ceramic Coating' })
  })
  it('a saved config keeps its own services; a newly added default appears switched OFF', async () => {
    const { mergeBookingConfig } = await import('./policy')
    const cfg = mergeBookingConfig({ services: [{ key: 'complete_detail', label: 'Complete Detail', enabled: true }] })
    expect(cfg.services[0]).toMatchObject({ key: 'complete_detail', label: 'Complete Detail', enabled: true })
    expect(cfg.services.find((s) => s.key === 'premium_detail')).toMatchObject({ enabled: false })
  })
  it('unfinished-booking automations default OFF with the proposed values', async () => {
    const { mergeBookingConfig } = await import('./policy')
    const cfg = mergeBookingConfig({})
    expect(cfg).toMatchObject({ draftFollowUpEnabled: false, draftFollowUpDelayHours: 24, draftRetentionEnabled: false, draftRetentionDays: 90 })
    expect(mergeBookingConfig({ draftRetentionDays: 2 }).draftRetentionDays).toBe(90) // below the 7-day floor → default
  })
})

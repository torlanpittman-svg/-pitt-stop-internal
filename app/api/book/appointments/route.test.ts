/**
 * The public booking route's ONE non-negotiable: a customer's booking response never waits on
 * anything to do with telling staff about it.
 *
 * The alert tables are not part of the booking transaction, but that alone is not enough — awaiting
 * the alert WRITE on the response path would still let a locked table, a slow Neon branch or a
 * missing migration hold a customer on the "booking…" spinner after their appointment was already
 * saved. So both recording and delivering the staff alert happen in `after()`, and these tests prove
 * the response is produced before either has started and regardless of how badly they go.
 *
 * Everything the route calls is mocked: no database, no email provider, no push service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  /** Stands in for the real BookingError the route checks with `instanceof`. */
  class FakeBookingError extends Error {
    constructor(public code: string, message: string) { super(message) }
  }
  return {
    FakeBookingError,
    /** Callbacks the route handed to `after()`; the test decides if and when they run. */
    afterCalls: [] as Array<() => unknown>,
    booking: {
      result: null as unknown,
      throws: null as unknown,
    },
    alerts: {
      recordCalls: 0,
      dispatchCalls: [] as unknown[],
      /** Overridable so a test can make recording hang or fail. */
      record: null as null | ((appointmentId: string) => Promise<string>),
      dispatch: null as null | (() => Promise<unknown>),
    },
  }
})

// `after()` is captured rather than executed: outside a Next request context it would not run, and
// the point of these tests is exactly WHEN it runs relative to the response.
vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: (fn: () => unknown) => { hoisted.afterCalls.push(fn) },
}))

vi.mock('@/apps/appointments/db', () => ({
  createAppointment: vi.fn(async () => {
    if (hoisted.booking.throws) throw hoisted.booking.throws
    return hoisted.booking.result
  }),
  getBookingConfig: vi.fn(async () => ({ confirmationEnabled: false })),
  hashIp: () => null,
  BookingError: hoisted.FakeBookingError,
}))
vi.mock('@/apps/appointments/notify', () => ({
  dispatchDue: vi.fn(async () => ({})),
  transactionalEmailProvider: () => ({ live: false }),
  AllowlistEmailProvider: class AllowlistEmailProvider { allows() { return false } },
}))
vi.mock('@/apps/appointments/public', () => ({ publicSummary: (a: { id: string }) => ({ id: a.id }) }))
vi.mock('@/apps/settings/db', () => ({ getMarketingConfig: vi.fn(async () => ({})) }))
vi.mock('@/apps/marketing/compliance', () => ({
  a2pProfile: () => ({}),
  smsDisclosureText: () => 'consent text',
  SMS_OPT_IN_VERSION: 'test-1',
}))
vi.mock('@/apps/staff-alerts/db', () => ({
  recordNewBookingAlert: vi.fn(async (appointmentId: string) => {
    hoisted.alerts.recordCalls++
    return hoisted.alerts.record ? hoisted.alerts.record(appointmentId) : `alert-${appointmentId}`
  }),
  dispatchStaffAlerts: vi.fn(async (opts: unknown) => {
    hoisted.alerts.dispatchCalls.push(opts)
    return hoisted.alerts.dispatch ? hoisted.alerts.dispatch() : {}
  }),
}))

import { POST } from './route'

const post = (over: Record<string, unknown> = {}) => POST(new Request('https://app/api/book/appointments', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    idempotencyKey: 'book-1-aaaaaaaa', date: '2026-10-20', time: '09:00', serviceKeys: ['complete_detail'],
    firstName: 'Alex', lastName: 'Rivera', phone: '(979) 555-0101', ...over,
  }),
}))

/** The staff-alert callback is the last one registered (the customer email dispatch is first). */
const staffAlertCallback = () => hoisted.afterCalls[hoisted.afterCalls.length - 1]
const settlesWithin = (work: Promise<unknown>, ms = 25) =>
  Promise.race([work.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('still running'), ms))])

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  hoisted.afterCalls.length = 0
  hoisted.alerts.recordCalls = 0
  hoisted.alerts.dispatchCalls.length = 0
  hoisted.alerts.record = null
  hoisted.alerts.dispatch = null
  hoisted.booking.throws = null
  hoisted.booking.result = { appointment: { id: 'appt-1', email: null, status: 'confirmed' }, token: 'tok-1', replayed: false }
})

describe('the staff alert never touches the customer response path', () => {
  it('answers the customer before any alert work has even started', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, token: 'tok-1' })
    // Nothing recorded, nothing dispatched: both are queued for after the response.
    expect(hoisted.alerts.recordCalls).toBe(0)
    expect(hoisted.alerts.dispatchCalls).toEqual([])
    expect(hoisted.afterCalls).toHaveLength(2)   // customer confirmation dispatch + staff alert
  })

  it('a never-resolving alert write cannot hold the booking response', async () => {
    hoisted.alerts.record = () => new Promise<string>(() => {})   // the write that never comes back

    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, token: 'tok-1' })

    // And it really is still hanging — the response was not merely faster, it was independent.
    const pending = Promise.resolve(staffAlertCallback()())
    expect(await settlesWithin(pending)).toBe('still running')
    expect(hoisted.alerts.dispatchCalls).toEqual([])
  })

  it('an alert write that throws cannot fail the booking, and is swallowed where it happens', async () => {
    hoisted.alerts.record = async () => { throw new Error('relation "staff_alerts" does not exist') }

    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })

    // The post-response callback must not reject either: an unhandled rejection in `after` is noise
    // at best and a torn-down invocation at worst.
    await expect(staffAlertCallback()()).resolves.toBeUndefined()
    expect(hoisted.alerts.dispatchCalls).toEqual([])
  })

  it('a push dispatch that throws cannot fail the booking', async () => {
    hoisted.alerts.dispatch = async () => { throw new Error('push service unreachable') }
    const res = await post()
    expect(res.status).toBe(200)
    await expect(staffAlertCallback()()).resolves.toBeUndefined()
  })

  it('delivers exactly the alert it just recorded, once the response is out', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    await staffAlertCallback()()
    expect(hoisted.alerts.recordCalls).toBe(1)
    expect(hoisted.alerts.dispatchCalls).toEqual([{ alertId: 'alert-appt-1' }])
  })

  it('records and dispatches nothing for a replayed submission (the double-tapped Book button)', async () => {
    hoisted.booking.result = { appointment: { id: 'appt-1', email: null, status: 'confirmed' }, token: 'tok-1', replayed: true }
    const res = await post()
    expect(res.status).toBe(200)
    expect(hoisted.afterCalls).toHaveLength(0)
    expect(hoisted.alerts.recordCalls).toBe(0)
  })

  it('queues no alert work when the booking itself was refused', async () => {
    hoisted.booking.throws = new hoisted.FakeBookingError('full', 'That time was just taken.')
    const res = await post()
    expect(res.status).toBe(409)
    expect(hoisted.afterCalls).toHaveLength(0)
    expect(hoisted.alerts.recordCalls).toBe(0)
  })
})

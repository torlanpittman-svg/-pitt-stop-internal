/**
 * declineEstimateAction — the gate lives INSIDE the server action: manager/admin verified before any
 * mutation, UUID validated server-side, no email dispatch ever triggered, and the right surfaces
 * revalidated. The data layer is mocked; its own behaviour is covered by decline.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`) }) }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActor: vi.fn(), authorizedManager: vi.fn(), authorizedManagerStrict: vi.fn(),
  employeeAuthorized: vi.fn(), isManagerRole: vi.fn(),
}))
vi.mock('@/apps/appointments/drafts', () => ({ setDraftStaffStatus: vi.fn(), requeueDraftFollowUp: vi.fn(), STAFF_STATUSES: ['new', 'contacted', 'closed'] }))
vi.mock('@/apps/appointments/checkin', () => ({ checkInAppointment: vi.fn() }))
vi.mock('@/apps/appointments/notify', () => ({ dispatchDue: vi.fn(), requeueNotification: vi.fn() }))
vi.mock('@/apps/appointments/policy', () => ({ mergeBookingConfig: vi.fn((c: unknown) => c), WEEKDAYS: [] }))
vi.mock('@/apps/appointments/db', () => {
  class BookingError extends Error {
    constructor(public code: string, message: string) { super(message) }
  }
  return {
    createAppointment: vi.fn(), cancelAppointment: vi.fn(), markNoShow: vi.fn(), rescheduleAppointment: vi.fn(),
    acknowledgeAppointments: vi.fn(), addInternalNote: vi.fn(), addBlock: vi.fn(), removeBlock: vi.fn(),
    declineEstimate: vi.fn(), getAvailability: vi.fn(), getBookingConfig: vi.fn(), saveBookingConfig: vi.fn(),
    BookingError, APPOINTMENT_SOURCES: ['website_booking', 'phone'],
  }
})

import { declineEstimateAction } from './actions'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { declineEstimate, BookingError } from '@/apps/appointments/db'
import { dispatchDue } from '@/apps/appointments/notify'
import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

const APPT = '7b6a2d1e-3c4f-4a5b-8c9d-0e1f2a3b4c5d'
beforeEach(() => vi.clearAllMocks())

describe('declineEstimateAction', () => {
  it('refuses a non-manager before touching anything', async () => {
    ;(authorizedManager as Mock).mockResolvedValue(null)
    const r = await declineEstimateAction(APPT, 'price too high')
    expect(r).toEqual({ ok: false, error: 'Managers and admins only.' })
    expect(declineEstimate).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('rejects a malformed or non-string id server-side, after auth, before any mutation', async () => {
    ;(authorizedManager as Mock).mockResolvedValue({ name: 'Manager Mia' })
    expect(await declineEstimateAction("1'; DROP TABLE appointments; --", 'x')).toEqual({ ok: false, error: 'Invalid appointment.' })
    expect(await declineEstimateAction(123 as unknown as string, 'x')).toEqual({ ok: false, error: 'Invalid appointment.' })
    expect(declineEstimate).not.toHaveBeenCalled()
  })

  it('rejects a non-string or over-long reason without mutating', async () => {
    ;(authorizedManager as Mock).mockResolvedValue({ name: 'Manager Mia' })
    expect(await declineEstimateAction(APPT, 42 as unknown as string)).toEqual({ ok: false, error: 'Invalid reason.' })
    expect(await declineEstimateAction(APPT, 'x'.repeat(301))).toEqual({ ok: false, error: 'Keep the reason under 300 characters.' })
    expect(declineEstimate).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('manager path: declines with the actor and trimmed reason, revalidates appointment + marketing surfaces, sends NOTHING', async () => {
    ;(authorizedManager as Mock).mockResolvedValue({ name: 'Manager Mia' })
    ;(declineEstimate as Mock).mockResolvedValue({ appointment: { id: APPT, status: 'declined' }, lead: 'lost' })
    const r = await declineEstimateAction(APPT, '  price too high  ')
    expect(r).toEqual({ ok: true, lead: 'lost' })
    expect(declineEstimate).toHaveBeenCalledTimes(1)
    const [id, opts] = (declineEstimate as Mock).mock.calls[0]
    expect(id).toBe(APPT)
    expect(opts.actor).toBe('Manager Mia')
    expect(opts.reason).toBe('price too high')
    for (const p of ['/appointments', `/appointments/${APPT}`, '/marketing/leads', '/marketing/report', '/marketing']) {
      expect(revalidatePath).toHaveBeenCalledWith(p)
    }
    // Never a dispatch: declining must not run the email outbox, directly or via after().
    expect(dispatchDue).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('an empty reason is passed as null (optional), and the honest lead outcome is returned as-is', async () => {
    ;(authorizedManager as Mock).mockResolvedValue({ name: 'Manager Mia' })
    ;(declineEstimate as Mock).mockResolvedValue({ appointment: { id: APPT, status: 'declined' }, lead: 'none' })
    const r = await declineEstimateAction(APPT, '')
    expect(r).toEqual({ ok: true, lead: 'none' })
    expect((declineEstimate as Mock).mock.calls[0][1].reason).toBeNull()
  })

  it('surfaces a data-layer conflict as the action error', async () => {
    ;(authorizedManager as Mock).mockResolvedValue({ name: 'Manager Mia' })
    ;(declineEstimate as Mock).mockRejectedValue(new BookingError('conflict', 'The linked marketing lead is already Won or linked to a job — update it on the Marketing leads screen instead.'))
    const r = await declineEstimateAction(APPT, '')
    expect(r).toEqual({ ok: false, error: 'The linked marketing lead is already Won or linked to a job — update it on the Marketing leads screen instead.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

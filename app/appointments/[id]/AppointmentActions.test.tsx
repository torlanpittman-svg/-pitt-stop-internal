/**
 * "Which vehicle is here?" — what check-in SUBMITS, tested without a DOM (project convention): the
 * submission rule is the pure submittedVehicleChoice, and static markup pins when the selector is on
 * screen at all.
 *
 * Regression: with a staff-entered VIN on the appointment and exactly one saved vehicle matching the
 * booked year/make/model, the selector is hidden but the preselected match used to be submitted anyway,
 * silently overriding the typed VIN server-side. A hidden selector must submit nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../actions', () => ({ checkInAction: vi.fn(), noShowAction: vi.fn(), cancelAction: vi.fn(), rescheduleAction: vi.fn(), noteAction: vi.fn() }))
vi.mock('../SlotPicker', () => ({ default: () => null }))

import AppointmentActions, { submittedVehicleChoice, type SavedVehicleOption } from './AppointmentActions'

const truck = (over: Partial<SavedVehicleOption> = {}): SavedVehicleOption =>
  ({ id: 'b2f7f0a4-0000-0000-0000-000000000001', label: '2019 Ford F-150', color: 'Blue', vin: '1FTFW1E52KFA00002', matches: true, ...over })

const render = (over: Partial<Parameters<typeof AppointmentActions>[0]> = {}) => renderToStaticMarkup(
  <AppointmentActions id="a1" status="confirmed" hasJob={false} isManager={false} past={false}
    date="2026-11-10" time="08:00" serviceKeys={['complete_detail']}
    bookedVehicle="2019 Ford F-150" bookedVin={null} savedVehicles={[]} {...over} />,
)
const checkInButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Check in/)?.[0] ?? ''

describe('submittedVehicleChoice — a hidden selector submits NOTHING', () => {
  it('selector hidden (e.g. the appointment has its own VIN): null, even with a match preselected', () => {
    expect(submittedVehicleChoice(false, truck().id)).toBeNull()
    expect(submittedVehicleChoice(false, 'new')).toBeNull()
  })
  it('selector shown: the radio state maps to the submitted answer', () => {
    expect(submittedVehicleChoice(true, '')).toBeNull()
    expect(submittedVehicleChoice(true, 'new')).toEqual({ newVehicle: true })
    expect(submittedVehicleChoice(true, truck().id)).toEqual({ vehicleId: truck().id })
  })
})

describe('when the selector is on screen', () => {
  it('a staff-entered VIN hides it even when saved vehicles exist, and check-in stays enabled', () => {
    const html = render({ bookedVin: '1FTFW1E52KFA00001', savedVehicles: [truck()] })
    expect(html).not.toContain('Which vehicle is here?')
    const button = checkInButton(html)
    expect(button).toContain('Check in')              // the button was actually found — the check below must not pass on ''
    expect(button).not.toContain('disabled=""')
  })
  it('no VIN + saved vehicles: shown, the single booked-YMM match preselected, saved VINs visible', () => {
    const html = render({ savedVehicles: [truck(), truck({ id: 'v2', label: '2017 GMC Sierra', vin: null, matches: false })] })
    expect(html).toContain('Which vehicle is here?')
    expect(html).toContain('1FTFW1E52KFA00002')
    expect(html).toContain('checked=""')
    const button = checkInButton(html)
    expect(button).toContain('Check in')
    expect(button).not.toContain('disabled=""')
  })
  it('several matches: nothing preselected, so check-in is disabled until staff answer', () => {
    const html = render({ savedVehicles: [truck(), truck({ id: 'v2', vin: '1FTFW1E52KFA00003' })] })
    expect(html).toContain('Which vehicle is here?')
    expect(html).not.toContain('checked=""')
    expect(checkInButton(html)).toContain('disabled=""')
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { validateCompletion, completionRecord, completionEnabled, shopTimezone } from './completion'

const confirmed = { allWorkComplete: true }

describe('validateCompletion — one confirmation: "All work is complete and this vehicle is ready."', () => {
  it('rejects a Job with no work listed (must add/confirm work first)', () => {
    expect(validateCompletion([], false, confirmed)).toEqual({ ok: false, error: 'no_services' })
    expect(validateCompletion(null, false, confirmed)).toEqual({ ok: false, error: 'no_services' })
    expect(validateCompletion(['  '], false, confirmed)).toEqual({ ok: false, error: 'no_services' })
  })
  it('requires a confirmation payload', () => {
    expect(validateCompletion(['Wax'], false, undefined)).toEqual({ ok: false, error: 'checklist_required' })
    expect(validateCompletion(['Wax'], false, null)).toEqual({ ok: false, error: 'checklist_required' })
  })
  it('requires the single explicit confirmation — anything but true is refused', () => {
    expect(validateCompletion(['Wax'], false, {})).toEqual({ ok: false, error: 'confirmation_required' })
    expect(validateCompletion(['Wax'], false, { allWorkComplete: false })).toEqual({ ok: false, error: 'confirmation_required' })
    expect(validateCompletion(['Wax'], false, { allWorkComplete: 'yes' as unknown as boolean })).toEqual({ ok: false, error: 'confirmation_required' })
  })
  it('no longer needs (or accepts as a substitute) per-service acknowledgements or the old final-check boxes', () => {
    expect(validateCompletion(['Interior Detail', 'Wax'], false, confirmed)).toEqual({ ok: true })
    const legacy = { servicesAck: ['Interior Detail', 'Wax'], noRemaining: true, finalTouches: true } as never
    expect(validateCompletion(['Interior Detail', 'Wax'], false, legacy)).toEqual({ ok: false, error: 'confirmation_required' })
  })
  it('enforces QC only when qcRequired, and never treats the confirmation as a QC pass', () => {
    expect(validateCompletion(['Wax'], false, { allWorkComplete: true, qcPassed: false }).ok).toBe(true)
    expect(validateCompletion(['Wax'], true, confirmed)).toEqual({ ok: false, error: 'qc_required' })
    expect(validateCompletion(['Wax'], true, { allWorkComplete: true, qcPassed: false })).toEqual({ ok: false, error: 'qc_required' })
    expect(validateCompletion(['Wax'], true, { allWorkComplete: true, qcPassed: true })).toEqual({ ok: true })
    expect(validateCompletion(['Wax'], true, { allWorkComplete: false, qcPassed: true })).toEqual({ ok: false, error: 'confirmation_required' })
  })
})

describe('completionRecord — what is stored on the Job (only real answers, never client extras)', () => {
  it('records the confirmation, QC only when it was required, who and when', () => {
    const at = new Date('2026-10-20T15:00:00Z')
    expect(completionRecord(false, { allWorkComplete: true, qcPassed: true, servicesAck: ['x'] } as never, 'Tony', at))
      .toEqual({ allWorkComplete: true, at: '2026-10-20T15:00:00.000Z', by: 'Tony' })
    expect(completionRecord(true, { allWorkComplete: true, qcPassed: true }, 'Tony', at))
      .toEqual({ allWorkComplete: true, qcPassed: true, at: '2026-10-20T15:00:00.000Z', by: 'Tony' })
  })
})

describe('config', () => {
  const OLD = { ...process.env }
  afterEach(() => { process.env = { ...OLD } })
  it('completionEnabled reflects the flag', () => {
    delete process.env.COMPLETION_FLOW_ENABLED; expect(completionEnabled()).toBe(false)
    process.env.COMPLETION_FLOW_ENABLED = 'true'; expect(completionEnabled()).toBe(true)
  })
  it('shopTimezone defaults to America/Chicago', () => {
    delete process.env.SHOP_TIMEZONE; expect(shopTimezone()).toBe('America/Chicago')
    process.env.SHOP_TIMEZONE = 'America/New_York'; expect(shopTimezone()).toBe('America/New_York')
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { validateCompletion, completionEnabled, shopTimezone } from './completion'

const full = (services: string[]) => ({ servicesAck: services, noRemaining: true, finalTouches: true, qcPassed: true })

describe('validateCompletion', () => {
  it('rejects a Job with no services (must add/confirm work first)', () => {
    expect(validateCompletion([], false, full([]))).toEqual({ ok: false, error: 'no_services' })
    expect(validateCompletion(null, false, full([]))).toEqual({ ok: false, error: 'no_services' })
  })
  it('requires a checklist payload', () => {
    expect(validateCompletion(['Wax'], false, undefined)).toEqual({ ok: false, error: 'checklist_required' })
  })
  it('requires EVERY assigned service to be acknowledged', () => {
    const r = validateCompletion(['Interior Detail', 'Wax'], false, { servicesAck: ['Interior Detail'], noRemaining: true, finalTouches: true })
    expect(r.ok).toBe(false); expect(r.error).toBe('services_unacknowledged'); expect(r.missing).toEqual(['Wax'])
  })
  it('acknowledges services case-insensitively; custom "Other" text counts', () => {
    expect(validateCompletion(['Wax', 'Headliner steam clean'], false,
      { servicesAck: ['wax', 'Headliner steam clean'], noRemaining: true, finalTouches: true }).ok).toBe(true)
  })
  it('requires the general final checks', () => {
    expect(validateCompletion(['Wax'], false, { servicesAck: ['Wax'], noRemaining: false, finalTouches: true }).error).toBe('general_checks')
    expect(validateCompletion(['Wax'], false, { servicesAck: ['Wax'], noRemaining: true, finalTouches: false }).error).toBe('general_checks')
  })
  it('enforces QC only when qcRequired', () => {
    // not required → QC unchecked is fine
    expect(validateCompletion(['Wax'], false, { servicesAck: ['Wax'], noRemaining: true, finalTouches: true, qcPassed: false }).ok).toBe(true)
    // required → QC must pass
    expect(validateCompletion(['Wax'], true, { servicesAck: ['Wax'], noRemaining: true, finalTouches: true, qcPassed: false }).error).toBe('qc_required')
    expect(validateCompletion(['Wax'], true, { servicesAck: ['Wax'], noRemaining: true, finalTouches: true, qcPassed: true }).ok).toBe(true)
  })
  it('passes when everything is acknowledged', () => {
    expect(validateCompletion(['Interior Detail', 'Wax'], false, full(['Interior Detail', 'Wax']))).toEqual({ ok: true })
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

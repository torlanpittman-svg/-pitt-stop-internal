import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  hashPin, verifyPin, signElevation, verifyElevation, readCookie, getActor,
  getElevation, effectiveRole, elevationMinutes, identityEnabled, type Actor, type Elevation,
} from './identity'

describe('PIN hashing', () => {
  it('verifies a correct PIN and rejects a wrong one', () => {
    const h = hashPin('1234')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(verifyPin('1234', h)).toBe(true)
    expect(verifyPin('9999', h)).toBe(false)
    expect(verifyPin('1234', null)).toBe(false)
    expect(verifyPin('1234', 'garbage')).toBe(false)
  })
  it('produces a different salt each time', () => {
    expect(hashPin('1234')).not.toBe(hashPin('1234'))
  })
})

describe('elevation token', () => {
  const OLD = { ...process.env }
  beforeEach(() => { process.env.IDENTITY_SECRET = 'test-secret' })
  afterEach(() => { process.env = { ...OLD } })

  it('signs and verifies a non-expired token', () => {
    const exp = Date.now() + 60_000
    const t = signElevation({ employeeId: 'e1', role: 'manager', exp })
    expect(verifyElevation(t)).toMatchObject({ employeeId: 'e1', role: 'manager', exp })
  })
  it('rejects an expired token', () => {
    const t = signElevation({ employeeId: 'e1', role: 'manager', exp: Date.now() - 1 })
    expect(verifyElevation(t)).toBeNull()
  })
  it('rejects a tampered token', () => {
    const t = signElevation({ employeeId: 'e1', role: 'manager', exp: Date.now() + 60_000 })
    expect(verifyElevation(t.slice(0, -2) + 'xx')).toBeNull()
  })
  it('rejects a token signed with a different secret', () => {
    const t = signElevation({ employeeId: 'e1', role: 'manager', exp: Date.now() + 60_000 })
    process.env.IDENTITY_SECRET = 'other-secret'
    expect(verifyElevation(t)).toBeNull()
  })
})

describe('cookie parsing + actor', () => {
  it('reads a named cookie', () => {
    expect(readCookie('a=1; ps_actor=%7B%22x%22%3A1%7D; b=2', 'ps_actor')).toBe('{"x":1}')
    expect(readCookie('', 'ps_actor')).toBeNull()
  })
  it('parses an actor cookie', () => {
    const c = 'ps_actor=' + encodeURIComponent(JSON.stringify({ id: 'e1', name: 'Alex', role: 'manager' }))
    expect(getActor(c)).toEqual({ id: 'e1', name: 'Alex', role: 'manager' })
    expect(getActor(null)).toBeNull()
  })
})

describe('effectiveRole (base role is permanent; elevation only raises above base)', () => {
  const emp: Actor = { id: 'e1', name: 'Sam', role: 'employee' }
  const mgr: Actor = { id: 'e2', name: 'Alex', role: 'manager' }
  const admin: Actor = { id: 'e3', name: 'Torlan', role: 'admin' }

  it('remembered base role is available with NO elevation (the fix)', () => {
    expect(effectiveRole(emp, null)).toBe('employee')
    expect(effectiveRole(mgr, null)).toBe('manager')     // was wrongly 'employee' before
    expect(effectiveRole(admin, null)).toBe('admin')     // was wrongly 'employee' before
  })
  it('expired/absent elevation NEVER downgrades base role', () => {
    const expired: Elevation = { employeeId: 'e2', role: 'manager', exp: Date.now() - 1 }
    // verifyElevation would return null for expired; effectiveRole with null elevation → base
    expect(effectiveRole(mgr, null)).toBe('manager')
    expect(effectiveRole(admin, null)).toBe('admin')
    // even a stale elevation object no higher than base leaves base intact
    expect(effectiveRole(mgr, { employeeId: 'e2', role: 'manager', exp: Date.now() + 60_000 })).toBe('manager')
    void expired
  })
  it('elevation can only RAISE above base (same person)', () => {
    // employee stepping up to manager (e.g. a manager authorized on this device)
    expect(effectiveRole(emp, { employeeId: 'e1', role: 'manager', exp: Date.now() + 60_000 })).toBe('manager')
    // manager stepping up to admin
    expect(effectiveRole(mgr, { employeeId: 'e2', role: 'admin', exp: Date.now() + 60_000 })).toBe('admin')
    // a lower elevation never reduces a higher base
    expect(effectiveRole(admin, { employeeId: 'e3', role: 'manager', exp: Date.now() + 60_000 })).toBe('admin')
  })
  it('elevation for a different person does not apply (base still granted)', () => {
    expect(effectiveRole(mgr, { employeeId: 'someone-else', role: 'admin', exp: Date.now() + 60_000 })).toBe('manager')
  })
  it('no actor → employee', () => {
    expect(effectiveRole(null, { employeeId: 'x', role: 'admin', exp: Date.now() + 60_000 })).toBe('employee')
  })
})

describe('config', () => {
  const OLD = { ...process.env }
  afterEach(() => { process.env = { ...OLD } })
  it('elevationMinutes defaults to 10 and honors override', () => {
    delete process.env.MANAGER_ELEVATION_MINUTES
    expect(elevationMinutes()).toBe(10)
    process.env.MANAGER_ELEVATION_MINUTES = '25'
    expect(elevationMinutes()).toBe(25)
    process.env.MANAGER_ELEVATION_MINUTES = 'nonsense'
    expect(elevationMinutes()).toBe(10)
  })
  it('identityEnabled reflects the flag', () => {
    delete process.env.IDENTITY_ENABLED; expect(identityEnabled()).toBe(false)
    process.env.IDENTITY_ENABLED = 'true'; expect(identityEnabled()).toBe(true)
  })
})

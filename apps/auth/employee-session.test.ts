import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  resolveIdentityByPin, signEmployeeSession, verifyEmployeeToken, authedActorFromToken,
  employeeAuthConfigured, identityPinsConfigured, EMPLOYEE_IDENTITIES,
} from './employee-session'

// Throwaway TEST PINs — NOT the production values. Real PINs live only in the deploy env.
const TEST_PINS = { darryl: '4001', tony: '4002', torlan: '4003' }

const OLD = { ...process.env }
function clearAuthEnv() {
  delete process.env.EMPLOYEE_PIN
  for (const i of EMPLOYEE_IDENTITIES) delete process.env[i.pinEnv]
}
beforeEach(() => {
  process.env.IDENTITY_SECRET = 'test-secret'
  clearAuthEnv()
  process.env.PIN_DARRYL = TEST_PINS.darryl
  process.env.PIN_TONY = TEST_PINS.tony
  process.env.PIN_TORLAN = TEST_PINS.torlan
})
afterEach(() => { process.env = { ...OLD } })

describe('resolveIdentityByPin — a PIN identifies WHO (server-side)', () => {
  it('maps each configured PIN to the right identity + role', () => {
    expect(resolveIdentityByPin(TEST_PINS.darryl)).toEqual({ key: 'darryl', name: 'Darryl', role: 'manager' })
    expect(resolveIdentityByPin(TEST_PINS.tony)).toEqual({ key: 'tony', name: 'Tony', role: 'manager' })
    expect(resolveIdentityByPin(TEST_PINS.torlan)).toEqual({ key: 'torlan', name: 'Torlan', role: 'manager' })
  })
  it('Darryl, Tony, and Torlan are ALL managers with identical role (no manager tiers)', () => {
    const darryl = resolveIdentityByPin(TEST_PINS.darryl)!
    const tony = resolveIdentityByPin(TEST_PINS.tony)!
    const torlan = resolveIdentityByPin(TEST_PINS.torlan)!
    expect(darryl.role).toBe('manager')
    expect(tony.role).toBe('manager')
    expect(torlan.role).toBe('manager')
    expect(darryl.role).toBe(torlan.role)
    expect(tony.role).toBe(torlan.role)
  })
  it('manager is NEVER admin — no PIN resolves to the admin role', () => {
    for (const p of Object.values(TEST_PINS)) {
      expect(resolveIdentityByPin(p)!.role).not.toBe('admin')
    }
  })
  it('rejects an unknown / malformed PIN', () => {
    expect(resolveIdentityByPin('0000')).toBeNull()   // not configured
    expect(resolveIdentityByPin('12')).toBeNull()      // too short
    expect(resolveIdentityByPin('abcd')).toBeNull()    // non-numeric
    expect(resolveIdentityByPin('')).toBeNull()
  })
  it('an unconfigured identity does not resolve', () => {
    delete process.env.PIN_TORLAN
    expect(resolveIdentityByPin(TEST_PINS.torlan)).toBeNull()
  })
})

describe('signed session carries tamper-proof identity claims', () => {
  it('round-trips {key,name,role} through sign → verify → authedActorFromToken', async () => {
    const actor = { key: 'torlan', name: 'Torlan', role: 'manager' as const }
    const tok = await signEmployeeSession(actor)
    const payload = await verifyEmployeeToken(tok)
    expect(payload).not.toBeNull()
    expect(authedActorFromToken(payload)).toEqual(actor)
  })
  it('an anonymous (legacy) session verifies but has no identity', async () => {
    const tok = await signEmployeeSession(null)
    const payload = await verifyEmployeeToken(tok)
    expect(payload).not.toBeNull()
    expect(authedActorFromToken(payload)).toBeNull()
  })
  it('rejects a tampered token (role cannot be forged)', async () => {
    const tok = await signEmployeeSession({ key: 'darryl', name: 'Darryl', role: 'employee' })
    expect(await verifyEmployeeToken(tok.slice(0, -2) + 'xx')).toBeNull()
  })
  it('rejects an expired token', async () => {
    const tok = await signEmployeeSession({ key: 'tony', name: 'Tony', role: 'employee' }, -1)
    expect(await verifyEmployeeToken(tok)).toBeNull()
  })
  it('rejects a token signed with a different secret', async () => {
    const tok = await signEmployeeSession({ key: 'torlan', name: 'Torlan', role: 'manager' })
    process.env.IDENTITY_SECRET = 'other-secret'
    expect(await verifyEmployeeToken(tok)).toBeNull()
  })
})

describe('gate configuration', () => {
  it('is configured when individual PINs are set', () => {
    expect(identityPinsConfigured()).toBe(true)
    expect(employeeAuthConfigured()).toBe(true)
  })
  it('is configured by the legacy shared PIN alone', () => {
    clearAuthEnv()
    expect(identityPinsConfigured()).toBe(false)
    process.env.EMPLOYEE_PIN = '9999'
    expect(employeeAuthConfigured()).toBe(true)
  })
  it('is unconfigured (open/dev) when nothing is set', () => {
    clearAuthEnv()
    expect(employeeAuthConfigured()).toBe(false)
  })
})

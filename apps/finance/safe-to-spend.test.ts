import { describe, it, expect } from 'vitest'
import { computeCoreSafeToSpendCents } from './safe-to-spend'

// The protected one-week payroll FLOOR must be a separate liquidity cushion, never a re-subtraction
// of the scheduled Friday payroll (which is already inside `criticalCents`). These tests lock that in.
describe('Safe-to-Spend core arithmetic + payroll floor', () => {
  const weeklyPayroll = 304032 // Torlan 157245 + Tony 100612 + Darryl 46175 = $3,040.32

  it('subtracts the payroll floor once, on top of obligations (no double-count of the same payroll)', () => {
    // Scenario: $10,000 cash. This week's payroll ($3,040.32) IS the only critical obligation.
    // Floor = one week payroll. Core = 10000 − 3040.32(obligation) − 3040.32(floor) = $3,919.36.
    const core = computeCoreSafeToSpendCents({
      availableCents: 1_000_000, criticalCents: weeklyPayroll, contractualCents: 0, reservesCents: 0, payrollFloorCents: weeklyPayroll,
    })
    expect(core).toBe(1_000_000 - weeklyPayroll - weeklyPayroll)
    // Sanity: the scheduled payroll appears exactly once as an obligation; the floor is a DISTINCT
    // constant. Removing the floor gives back exactly one payroll of headroom — proving it was added
    // once, not folded twice into `criticalCents`.
    const withoutFloor = computeCoreSafeToSpendCents({
      availableCents: 1_000_000, criticalCents: weeklyPayroll, contractualCents: 0, reservesCents: 0, payrollFloorCents: 0,
    })
    expect((withoutFloor as number) - (core as number)).toBe(weeklyPayroll)
  })

  it('is negative when obligations + floor exceed verified cash (a horizon gap, not "cannot make payroll")', () => {
    const core = computeCoreSafeToSpendCents({
      availableCents: 501_554, criticalCents: 1_824_468, contractualCents: 1_071_240, reservesCents: 0, payrollFloorCents: weeklyPayroll,
    })
    // $5,015.54 − $18,244.68 − $10,712.40 − $0 − $3,040.32 = −$26,981.86
    expect(core).toBe(501_554 - 1_824_468 - 1_071_240 - weeklyPayroll)
    expect(core as number).toBeLessThan(0)
  })

  it('the long-term reserve TARGET is passed via reservesCents and is $0 when unconfigured — the floor still protects', () => {
    const core = computeCoreSafeToSpendCents({
      availableCents: 1_000_000, criticalCents: 0, contractualCents: 0, reservesCents: 0, payrollFloorCents: weeklyPayroll,
    })
    // With no reserve policy configured, cash minus only the payroll floor is still protected.
    expect(core).toBe(1_000_000 - weeklyPayroll)
  })

  it('returns null when there is no verified operating balance', () => {
    expect(computeCoreSafeToSpendCents({ availableCents: null, criticalCents: 0, contractualCents: 0, reservesCents: 0, payrollFloorCents: weeklyPayroll })).toBeNull()
  })
})

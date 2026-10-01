import { describe, it, expect, afterEach } from 'vitest'
import { partsEmployeeVisible, partsVisibleFor } from './visibility'

const OLD = process.env.PARTS_EMPLOYEE_VISIBLE
afterEach(() => {
  if (OLD === undefined) delete process.env.PARTS_EMPLOYEE_VISIBLE
  else process.env.PARTS_EMPLOYEE_VISIBLE = OLD
})

describe('parts rollout gate — reversible, manager-testable, default hidden from employees', () => {
  it('defaults OFF when the flag is unset (employees hidden, managers always see parts)', () => {
    delete process.env.PARTS_EMPLOYEE_VISIBLE
    expect(partsEmployeeVisible()).toBe(false)
    expect(partsVisibleFor(false)).toBe(false) // employee: hidden
    expect(partsVisibleFor(true)).toBe(true)   // manager/admin: can test
  })

  it('managers/admins always see parts regardless of the flag', () => {
    for (const v of [undefined, 'false', '0', 'off', '', 'true', '1']) {
      if (v === undefined) delete process.env.PARTS_EMPLOYEE_VISIBLE
      else process.env.PARTS_EMPLOYEE_VISIBLE = v
      expect(partsVisibleFor(true)).toBe(true)
    }
  })

  it('flipping the flag on reveals parts to employees too (reversible)', () => {
    for (const on of ['true', '1', 'on', 'yes', 'TRUE', ' Yes ']) {
      process.env.PARTS_EMPLOYEE_VISIBLE = on
      expect(partsEmployeeVisible()).toBe(true)
      expect(partsVisibleFor(false)).toBe(true)
    }
  })

  it('treats anything else as off (fail-closed to hidden)', () => {
    for (const off of ['false', '0', 'off', 'no', 'nope', 'enabled?', '']) {
      process.env.PARTS_EMPLOYEE_VISIBLE = off
      expect(partsEmployeeVisible()).toBe(false)
      expect(partsVisibleFor(false)).toBe(false)
    }
  })
})

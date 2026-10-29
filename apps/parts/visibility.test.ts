import { describe, it, expect, afterEach } from 'vitest'
import { partsEmployeeVisible, partsVisibleFor, partsScreenshotImportEnabled } from './visibility'

const EMP = 'PARTS_EMPLOYEE_VISIBLE'
const IMP = 'PARTS_SCREENSHOT_IMPORT_ENABLED'
const OLD_EMP = process.env[EMP]
const OLD_IMP = process.env[IMP]
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
afterEach(() => { restore(EMP, OLD_EMP); restore(IMP, OLD_IMP) })

describe('legacy rollout gate (import flag OFF) — reversible, manager-testable, default hidden from employees', () => {
  it('defaults OFF when the flag is unset (employees hidden, managers always see parts)', () => {
    delete process.env[EMP]; delete process.env[IMP]
    expect(partsEmployeeVisible()).toBe(false)
    expect(partsVisibleFor(false)).toBe(false) // employee: hidden
    expect(partsVisibleFor(true)).toBe(true)   // manager/admin: can test
  })

  it('managers/admins always see parts regardless of the flags', () => {
    delete process.env[IMP]
    for (const v of [undefined, 'false', '0', 'off', '', 'true', '1']) {
      if (v === undefined) delete process.env[EMP]
      else process.env[EMP] = v
      expect(partsVisibleFor(true)).toBe(true)
    }
  })

  it('flipping the employee flag on reveals parts to employees too (reversible)', () => {
    delete process.env[IMP]
    for (const on of ['true', '1', 'on', 'yes', 'TRUE', ' Yes ']) {
      process.env[EMP] = on
      expect(partsEmployeeVisible()).toBe(true)
      expect(partsVisibleFor(false)).toBe(true)
    }
  })

  it('treats anything else as off (fail-closed to hidden)', () => {
    delete process.env[IMP]
    for (const off of ['false', '0', 'off', 'no', 'nope', 'enabled?', '']) {
      process.env[EMP] = off
      expect(partsEmployeeVisible()).toBe(false)
      expect(partsVisibleFor(false)).toBe(false)
    }
  })
})

describe('shared screenshot-import flag makes Parts visible to authorized shop users (equal permissions)', () => {
  it('when the import flag is ON, employees see Parts even if the legacy flag is OFF', () => {
    delete process.env[EMP]; process.env[IMP] = 'true'
    expect(partsScreenshotImportEnabled()).toBe(true)
    expect(partsVisibleFor(false)).toBe(true) // employee: visible via the shared workflow
    expect(partsVisibleFor(true)).toBe(true)  // manager: visible
  })

  it('visibility matrix: manager || legacy employee flag || import flag', () => {
    const cases: Array<{ emp: boolean; imp: boolean; employeeVisible: boolean }> = [
      { emp: false, imp: false, employeeVisible: false },
      { emp: true, imp: false, employeeVisible: true },
      { emp: false, imp: true, employeeVisible: true },
      { emp: true, imp: true, employeeVisible: true },
    ]
    for (const c of cases) {
      process.env[EMP] = c.emp ? 'true' : 'false'
      process.env[IMP] = c.imp ? 'true' : 'false'
      expect(partsVisibleFor(false)).toBe(c.employeeVisible)
      expect(partsVisibleFor(true)).toBe(true) // manager/admin always
    }
  })

  it('import flag OFF preserves the exact legacy behavior', () => {
    process.env[IMP] = 'false'
    delete process.env[EMP]
    expect(partsVisibleFor(false)).toBe(false)
    process.env[EMP] = 'true'
    expect(partsVisibleFor(false)).toBe(true)
  })
})

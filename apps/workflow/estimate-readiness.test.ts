/**
 * REGRESSION (red): a physical PART typed as a kind='service' line evades every readiness gate.
 *
 * Gap: estimateReadiness only inspects actual job_parts rows for the parts-labor check, so a service
 * line whose wording is clearly a physical part ("Driver-side mirror assembly", "Windshield") passes
 * as ready — no labor review, billed as plain Labor. The estimate/invoice must instead surface a
 * `service_as_part` issue asking for an explicit decision: convert it to a part, or confirm it is
 * service labor. It must NOT misfire on real work ("Paint driver-side mirror"), a catalog-matched
 * service, a confirmed custom line, or an actual part row.
 *
 * Pure test — no DB/QB/network. Fails on baseline because `service_as_part` is not detected yet.
 */
import { describe, it, expect } from 'vitest'
import { estimateReadiness, type ReadinessService, type ReadinessPart } from './estimate-readiness'

let n = 0
function svc(title: string, over: Partial<ReadinessService> = {}): ReadinessService {
  return { id: `svc-${++n}`, title, kind: 'service', catalogId: null, role: null, matchMethod: null, ...over }
}
const codesOf = (services: ReadinessService[], parts: ReadinessPart[] = []) =>
  estimateReadiness(services, parts).issues.map((i) => i.code as string)

describe('estimateReadiness — a part typed as a service must be caught before invoicing', () => {
  it('flags a physical-part service line (no identity, no work verb) with service_as_part and is not ready', () => {
    const mirror = svc('Driver-side mirror assembly')
    const r = estimateReadiness([mirror], [])
    expect(r.ready).toBe(false)
    const issue = r.issues.find((i) => (i.code as string) === 'service_as_part')
    expect(issue).toBeTruthy()
    expect(issue!.ids).toContain(mirror.id)
    expect(issue!.message).toMatch(/Driver-side mirror assembly/)
  })

  it('counts several part-like lines and names them', () => {
    const r = estimateReadiness([svc('Windshield'), svc('Passenger-side mirror assembly')], [])
    const issue = r.issues.find((i) => (i.code as string) === 'service_as_part')!
    expect(issue.ids).toHaveLength(2)
  })

  it('does NOT flag real work on a component (a service VERB makes it labor, not a part)', () => {
    // "Painting a mirror is service labor, not a part" — per the brief.
    expect(codesOf([svc('Paint driver-side mirror')])).not.toContain('service_as_part')
    expect(codesOf([svc('Clean passenger seat')])).not.toContain('service_as_part')
  })

  it('does NOT flag a line whose identity was already chosen (catalog-matched)', () => {
    expect(codesOf([svc('Driver-side mirror assembly', { catalogId: 'cat-1', matchMethod: 'manual' })])).not.toContain('service_as_part')
  })

  it('does NOT flag a line the user confirmed as custom labor ("this is service labor")', () => {
    expect(codesOf([svc('Driver-side mirror assembly', { matchMethod: 'custom' })])).not.toContain('service_as_part')
  })

  it('never flags an actual part ROW or a kind="part" line as service_as_part', () => {
    const parts: ReadinessPart[] = [{ id: 'p-1', description: 'Driver-side mirror assembly', laborStatus: 'part_only' }]
    expect(codesOf([svc('Driver-side mirror assembly', { kind: 'part' })], parts)).not.toContain('service_as_part')
  })

  it('a resolved estimate with only genuine services stays ready', () => {
    expect(estimateReadiness([svc('Paint driver-side mirror', { matchMethod: 'custom' }), svc('Interior Detail', { catalogId: 'cat-2' })], []).ready).toBe(true)
  })
})

describe('odor services — three separate services, no package', () => {
  it('Ozone Treatment + Air Duct Cleaning + Odor Treatment together is ready (no overlap warning)', () => {
    const r = estimateReadiness([
      svc('Ozone Treatment', { catalogId: 'oz', role: 'odor_ozone', matchMethod: 'exact' }),
      svc('Air Duct Cleaning', { catalogId: 'duct', role: 'odor_duct', matchMethod: 'exact' }),
      svc('Odor Treatment', { catalogId: 'odor', role: 'odor_treatment', matchMethod: 'exact' }),
      svc('Second ozone pass', { catalogId: 'oz', role: 'odor_ozone', matchMethod: 'exact' }),
    ], [])
    expect(r).toMatchObject({ ready: true, issues: [] })
  })
  it('a line on the retired package needs the service chosen (history kept, never auto-reinterpreted)', () => {
    const pkg = svc('Complete Odor Treatment', { catalogId: 'pkg', role: 'odor_complete', matchMethod: 'rule' })
    const r = estimateReadiness([pkg], [])
    expect(r.issues).toEqual([{ code: 'odor_choice', ids: [pkg.id], message: expect.stringMatching(/no longer offered/) }])
  })
  it('legacy odor wording without identity (generic or naming several services) needs a choice; ozone-only or duct-only is clear', () => {
    for (const t of ['Remove smoke odor', 'Odor Treatment', 'Odor / Ozone', 'Ozone + air ducts']) expect(codesOf([svc(t)])).toEqual(['odor_choice'])
    for (const t of ['Ozone', 'Clean air duct system']) expect(codesOf([svc(t)])).toEqual([])
  })
  it('a legacy name matching more than one service needs a choice; a confirmed custom line does not', () => {
    expect(codesOf([svc('Ceramic Coating', { ambiguousName: true })])).toEqual(['name_choice'])
    expect(codesOf([svc('Ceramic Coating', { ambiguousName: true, matchMethod: 'custom' })])).toEqual([])
  })
})

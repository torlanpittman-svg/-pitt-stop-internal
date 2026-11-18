/**
 * Job screen — Services / Parts / Expenses at rest (2026-11 simplification).
 *   • ONE compact "+ Add" beside Services; no "+ Add Service", no per-service "+ Add part" link, no "+ Add a part".
 *   • Parts attached to a service sit under it; a separate Parts section exists only when the Job has whole-job parts.
 *   • The PartsTech import is not on the screen (it lives inside the add-part form).
 *   • Expenses is one collapsed row: label, the recorded total (managers), chevron — details stay hidden until opened.
 * Rendered server-side (no DOM): the menu, the part form, focus and submission are exercised in the browser.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/apps/expenses/job-actions', () => ({
  loadJobExpensesAction: async () => ({ ok: true, data: null }), listLinkableReceiptsAction: async () => ({ ok: true, receipts: [] }),
  linkReceiptAction: async () => ({ ok: true }), changeAllocationAction: async () => ({ ok: true }), removeAllocationAction: async () => ({ ok: true }),
}))
vi.mock('@/apps/expenses/ui/JobPicker', () => ({ default: () => null }))

import JobItemsPanel, { type JobItemsPanelProps } from './JobItemsPanel'
import JobExpenses from './JobExpenses'
import type { EstimateViewData, PartView, ServiceView } from './estimate/save-feedback'

const svc = (id: string, title: string, cents: number): ServiceView => ({ id, title, declined: false, priceCents: cents, lineCents: cents } as unknown as ServiceView)
const part = (id: string, description: string, laborServiceId: string | null): PartView => ({
  id, description, quantity: 1, lineCents: 2500, sellPriceCents: 2500, unitCostCents: null, partNumber: null,
  laborStatus: laborServiceId ? 'included' : 'none', laborServiceId,
} as unknown as PartView)
const view = (services: ServiceView[], parts: PartView[]): EstimateViewData => ({ exists: true, flat: false, workTotalCents: 0, services, parts, incomplete: false, referenceCents: null } as unknown as EstimateViewData)

const noop = () => {}
const panel = (over: Partial<JobItemsPanelProps>) => renderToStaticMarkup(
  <JobItemsPanel orderId="o1" view={null} textServices={[]} manager canEdit partsVisible busy={false}
    onAddService={noop} onAddExpense={noop} onOpenService={noop} onOpenPart={noop}
    onRemoveServiceWithParts={async () => true} onRemoveTextService={async () => true} onChanged={noop}
    importPanel={<div>IMPORT-PANEL</div>} {...over} />,
)
const SERVICES = [svc('s1', 'Interior Detail', 20000), svc('s2', 'Replace Carpet', 30000), svc('s3', 'Interior Detail', 20000)]

describe('Job screen — one "+ Add", nothing repeated', () => {
  it('shows exactly one add control, labelled "+ Add", that opens a dialog', () => {
    const html = panel({ view: view(SERVICES, []) })
    const adds = html.match(/<button[^>]*>\+ Add[^<]*<\/button>/g) ?? []
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatch(/>\+ Add<\/button>$/)
    expect(adds[0]).toMatch(/aria-haspopup="dialog"/)
    expect(adds[0]).toMatch(/data-add-service/)   // still the focus landing spot after a removal
  })

  it('has no "+ Add Service", no per-service "+ Add part" link and no "+ Add a part" button', () => {
    for (const html of [panel({ view: view(SERVICES, []) }), panel({ view: null, textServices: ['Tint', 'Wax'] }), panel({ view: view(SERVICES, [part('p1', 'Carpet', 's2'), part('p2', 'Towels', null)]) })]) {
      expect(html).not.toContain('Add Service')
      expect(html).not.toContain('Add part to this service')
      expect(html).not.toContain('Add a part')
      expect(html).not.toContain('PartsTech')
      expect(html).not.toContain('IMPORT-PANEL')
      expect(html).not.toContain('<form')
    }
  })

  it('no Parts section when the Job has no whole-job parts — even with parts attached to services', () => {
    expect(panel({ view: view(SERVICES, []) })).not.toContain('job-parts-heading')
    const html = panel({ view: view(SERVICES, [part('p1', 'Replacement carpet', 's2')]) })
    expect(html).not.toContain('job-parts-heading')
    expect(html).toContain('aria-label="Parts for Replace Carpet"')
    expect(html).toContain('Replacement carpet')
  })

  it('a part attached to one of two same-named services is listed under THAT service only', () => {
    const html = panel({ view: view(SERVICES, [part('p9', 'Seat clips', 's3')]) })
    const rows = html.split('<li data-service="').slice(1)
    const of = (id: string) => rows.find((r) => r.startsWith(`${id}"`)) ?? ''
    expect(of('s3')).toContain('Seat clips')
    expect(of('s1')).not.toContain('Seat clips')
  })

  it('whole-job parts get a Parts section with its count', () => {
    const html = panel({ view: view(SERVICES, [part('p1', 'Carpet', 's2'), part('p2', 'Shop towels', null)]) })
    expect(html).toContain('job-parts-heading')
    expect(html).toMatch(/Parts<span[^>]*> · 1<\/span>/)
    expect(html).toContain('Shop towels')
  })

  it('a viewer without Parts access sees no parts and still gets the one "+ Add"', () => {
    const html = panel({ partsVisible: false, view: view(SERVICES, [part('p1', 'Carpet', 's2'), part('p2', 'Shop towels', null)]) })
    expect(html).not.toContain('Shop towels')
    expect(html).not.toContain('job-parts-heading')
    expect(html.match(/>\+ Add<\/button>/g)).toHaveLength(1)
  })

  it('a removed (cancelled) Job disables "+ Add"', () => {
    expect(panel({ cancelled: true, view: view(SERVICES, []) })).toMatch(/<button[^>]*disabled=""[^>]*>\+ Add<\/button>/)
  })

  it('service names and prices keep one row each (name button + price), with no control between them', () => {
    const html = panel({ view: view([svc('s1', 'Interior Detail', 20000)], []) })
    const row = html.split('<li data-service="s1"')[1].split('</li>')[0]
    expect(row.match(/<button/g)).toHaveLength(1)   // the tap-to-edit name only
    expect(row).toContain('Edit Interior Detail')
  })
})

describe('Expenses — one collapsed row', () => {
  it('renders a single toggle (collapsed) and keeps the details hidden', () => {
    const html = renderToStaticMarkup(<JobExpenses orderId="o1" manager={false} />)
    const toggle = html.match(/<button[^>]*data-job-expenses-toggle[^>]*>/)?.[0] ?? ''
    expect(toggle).toMatch(/aria-expanded="false"/)
    const controls = toggle.match(/aria-controls="([^"]+)"/)?.[1]
    expect(controls).toBeTruthy()
    expect(html).toMatch(new RegExp(`<div id="${controls}"[^>]*hidden=""`))
    expect(html).toContain('>Expenses<')
  })

  it('the existing add-receipt action is still inside the section (not removed), for an open Job only', () => {
    expect(renderToStaticMarkup(<JobExpenses orderId="o1" manager={false} />)).toContain('href="/expenses?job=o1"')
    expect(renderToStaticMarkup(<JobExpenses orderId="o1" manager={false} cancelled />)).not.toContain('/expenses?job=')
  })
})

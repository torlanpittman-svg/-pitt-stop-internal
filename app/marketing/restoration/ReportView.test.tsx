/**
 * Renders the pure RestorationReportView with SYNTHETIC props (report-fixture.ts) — the safe local review
 * of /marketing/restoration. What this proves: the report markup renders without auth/DB/network, unknown
 * values show as "—"/"Unavailable" (never $0), profitability is presented as unmeasured, and paid unit
 * costs carry their exact denominators. What it does NOT prove: the live page against migration 0076 data
 * (that needs the deployed app after 0076 is applied) — the data layer itself is covered by
 * apps/marketing/restoration.integration.test.ts on PGlite.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RestorationReportView } from './ReportView'
import { FIXTURE_POPULATED, FIXTURE_UNKNOWNS } from './report-fixture'

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('RestorationReportView (synthetic props — no DB)', () => {
  it('renders the populated fixture with funnel, revenue, labelled paid unit costs and the duplicate flag', () => {
    const html = renderToStaticMarkup(<RestorationReportView report={FIXTURE_POPULATED} />)
    const text = strip(html)
    expect(text).toContain('Funnel (unique leads, duplicates removed)')
    expect(text).toContain('+1 duplicate')
    expect(text).toContain('$1,200')                          // invoiced revenue
    expect(text).toContain('spend ÷ 1 Google Ads lead')       // paid CPL denominator named
    expect(text).toContain('not an acquisition cost')         // blended labelled
    expect(text).toContain('1 new invoiced Google Ads customer') // paid CAC denominator named
    expect(text).toContain('Unmeasured')                      // profitability
    expect(text).toContain('labor cost is not captured')
    // no contribution/profit FIGURES or TARGETS render as UI (the caveat sentence explaining that none is
    // computed is honest explanatory text and is allowed)
    expect(text).not.toMatch(/Contribution (after|before) ads|positive contribution|contribution target|profit target|modeled labor/i)
    expect(html).toContain('duplicate')                       // flagged row stays visible
  })
  it('renders every unknown as — or Unavailable, never as $0', () => {
    const html = renderToStaticMarkup(<RestorationReportView report={FIXTURE_UNKNOWNS} />)
    const text = strip(html)
    expect(text).toContain('Unavailable')
    expect(text).toContain('unknown, not $0')
    expect(text).toContain('Unmeasured')
    // the three unit tiles show the em-dash, not a zero-dollar figure
    expect(text).not.toMatch(/Cost per paid lead[^$]*\$0/)
    expect(text).not.toMatch(/Paid CAC[^$]*\$0\b/)
    expect(text).toContain('No completed restoration jobs in this window.')
    expect(text).toContain('No restoration estimate requests in this window.')
  })
  it('never renders a labor-cost input or owner setting (removed by owner decision 2026-11-07)', () => {
    for (const fixture of [FIXTURE_POPULATED, FIXTURE_UNKNOWNS]) {
      const html = renderToStaticMarkup(<RestorationReportView report={fixture} />)
      expect(html).not.toMatch(/laborCostPct|Modeled labor/i)
      expect(html).not.toMatch(/<form/i)
    }
  })
})

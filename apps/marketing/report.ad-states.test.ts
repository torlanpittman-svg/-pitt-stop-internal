import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AdDataMeta, AdReporting } from './ads-reporting'
import type { CategoryAdRollup } from './ads'

// Mock the data dependencies so the report's HONESTY logic (isEmpty / byChannel / null money) is
// exercised without a DB or network.
vi.mock('./ads-reporting', () => ({ loadAdReporting: vi.fn() }))
vi.mock('./attribution', () => ({
  attributedCompletedJobs: vi.fn(async () => [] as unknown[]),
  rollupBySource: vi.fn(() => [] as unknown[]),
  leadsBySource: vi.fn(async () => [] as unknown[]),
}))

import { loadAdReporting } from './ads-reporting'
import { attributedCompletedJobs, leadsBySource, rollupBySource } from './attribution'
import { marketingReport } from './report'

const RANGE = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-28T23:59:59Z') }

function adResult(meta: Partial<AdDataMeta>, byCategory: CategoryAdRollup[] = []): AdReporting {
  return {
    meta: { status: 'manual', source: 'manual_entry', fetchedAt: null, error: null, errorKind: null, account: null, ...meta },
    byCategory,
  }
}
const mocked = () => ({
  load: vi.mocked(loadAdReporting),
  jobs: vi.mocked(attributedCompletedJobs),
  leads: vi.mocked(leadsBySource),
  sources: vi.mocked(rollupBySource),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocked().sources.mockReturnValue([])
  mocked().jobs.mockResolvedValue([])
  mocked().leads.mockResolvedValue([])
})

describe('marketingReport — honest unavailable vs zero', () => {
  it('UNAVAILABLE ad data with no shop activity is NOT "empty" (we do not know), and keeps a Google Ads channel row', async () => {
    mocked().load.mockResolvedValue(adResult({ status: 'unavailable', source: 'google_ads_api', error: 'google_ads_http_403', errorKind: 'auth' }))
    const r = await marketingReport(RANGE)
    expect(r.isEmpty).toBe(false)                 // never claim "no activity" when ad data is unknown
    expect(r.spendCents).toBeNull()
    expect(r.adReportedRevenueCents).toBeNull()
    expect(r.roas).toBeNull()
    const ga = r.byChannel.find((c) => c.channel === 'google_ads')
    expect(ga).toBeTruthy()
    expect(ga!.spendCents).toBeNull()             // shown as unavailable, not dropped, not $0
    expect(r.adData.errorKind).toBe('auth')
  })

  it('UNAVAILABLE ad data WITH shop activity still renders shop data', async () => {
    mocked().load.mockResolvedValue(adResult({ status: 'unavailable', source: 'google_ads_api', error: 'google_ads_timeout', errorKind: 'transient' }))
    mocked().jobs.mockResolvedValue([{ serviceCategory: 'ceramic', invoicedCents: 10_000, quotedValueCents: 12_000 }] as never)
    mocked().leads.mockResolvedValue([{ source: 'google_ads', count: 2 }] as never)
    const r = await marketingReport(RANGE)
    expect(r.isEmpty).toBe(false)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(10_000)
    const ceramic = r.byService.find((s) => s.serviceCategory === 'ceramic')!
    expect(ceramic.spendCents).toBeNull()         // ad columns unavailable, not fabricated zero
    expect(ceramic.adReportedRevenueCents).toBeNull()
  })

  it('LIVE known values flow through as numbers', async () => {
    mocked().load.mockResolvedValue(adResult(
      { status: 'live', source: 'google_ads_api', fetchedAt: '2026-10-28T20:00:00Z' },
      [{ serviceCategory: 'ceramic', spendCents: 50_000, impressions: 10, clicks: 5, conversions: 2, revenueCents: 60_000, conversionValue: 600 }],
    ))
    const r = await marketingReport(RANGE)
    expect(r.spendCents).toBe(50_000)
    expect(r.adReportedRevenueCents).toBe(60_000)
    const ceramic = r.byService.find((s) => s.serviceCategory === 'ceramic')!
    expect(ceramic.spendCents).toBe(50_000)
  })

  it('LIVE empty + no shop activity is a TRUE zero (isEmpty true)', async () => {
    mocked().load.mockResolvedValue(adResult({ status: 'live', source: 'google_ads_api', fetchedAt: '2026-10-28T20:00:00Z' }, []))
    const r = await marketingReport(RANGE)
    expect(r.isEmpty).toBe(true)
    expect(r.spendCents).toBe(0)
  })

  it('MANUAL-only data reports numbers (not unavailable)', async () => {
    mocked().load.mockResolvedValue(adResult({ status: 'manual' }, [{ serviceCategory: 'general', spendCents: 1000, impressions: 1, clicks: 1, conversions: 1, revenueCents: 2000 }]))
    const r = await marketingReport(RANGE)
    expect(r.spendCents).toBe(1000)
    expect(r.adData.status).toBe('manual')
  })
})

describe('marketingReport — period basis + explicit ad range (shop/ad alignment)', () => {
  it('default (no adRange): basis is "utc" and the Google range is the UTC date of the instants', async () => {
    mocked().load.mockResolvedValue(adResult({ status: 'live', source: 'google_ads_api' }, []))
    const r = await marketingReport(RANGE)
    expect(r.periodBasis).toBe('utc')
    expect(r.range).toEqual({ from: '2026-10-01', to: '2026-10-28' })
    // the ad query used the UTC-derived strings
    expect(mocked().load).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-28' })
  })

  it('explicit adRange: basis "account_local" and the Google range is the passed local dates, NOT the instants\' UTC date', async () => {
    mocked().load.mockResolvedValue(adResult({ status: 'live', source: 'google_ads_api' }, []))
    // Shop instants intentionally end on Oct 29 UTC (= Oct 28 local end); the ad range must stay Oct 28.
    const shop = { from: new Date('2026-10-01T05:00:00.000Z'), to: new Date('2026-10-29T04:59:59.999Z') }
    const r = await marketingReport({ ...shop, adRange: { from: '2026-10-01', to: '2026-10-28' }, basis: 'account_local' })
    expect(r.periodBasis).toBe('account_local')
    expect(r.range).toEqual({ from: '2026-10-01', to: '2026-10-28' })
    expect(mocked().load).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-28' })
    // the SHOP side received the real local-day instants (so completed_at is filtered on the local day)
    expect(mocked().jobs).toHaveBeenCalledWith(expect.objectContaining({ to: shop.to }))
  })
})

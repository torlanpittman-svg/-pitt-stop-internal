/**
 * /marketing/restoration — weekly insurance-restoration acquisition report (manager/admin, read-only).
 * This file only gates, parses the date range and loads the data; ALL rendering lives in the pure
 * RestorationReportView so the page can be reviewed locally with synthetic props (ReportView.test.tsx)
 * without a database. Profitability is reported as unmeasured — labor cost is not captured, so no
 * contribution/margin figures exist here (owner decision 2026-11-07).
 */
import { requireMarketingManager, MarketingShell } from '@/app/marketing/_components'
import { restorationReport, currentWeekYmd } from '@/apps/marketing/restoration-report'
import { RestorationReportView } from './ReportView'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const YMD = /^\d{4}-\d{2}-\d{2}$/
const inputCls = 'rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm'
const btn = 'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500'

export default async function RestorationReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requireMarketingManager('/marketing/restoration')
  const { from: fromRaw, to: toRaw } = await searchParams
  const custom = fromRaw && toRaw && YMD.test(fromRaw) && YMD.test(toRaw) && fromRaw <= toRaw
  const ymd = custom ? { from: fromRaw!, to: toRaw! } : currentWeekYmd(new Date())
  const r = await restorationReport(ymd)

  return (
    <MarketingShell active="/marketing/restoration" title="Insurance Restoration" actions={
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-400">From<input type="date" name="from" defaultValue={ymd.from} className={`${inputCls} ml-1`} /></label>
        <label className="text-xs text-gray-400">To<input type="date" name="to" defaultValue={ymd.to} className={`${inputCls} ml-1`} /></label>
        <button className={btn} type="submit">Show</button>
      </form>
    }>
      <RestorationReportView report={r} />
    </MarketingShell>
  )
}

/**
 * Auto Sales — Monthly accountant report (ADMIN; gated by proxy.ts /admin/*). Renders the LIVE report
 * for the selected ?month=YYYY-MM (defaults to the current reporting-timezone month). Managers can
 * finalize a snapshot. No QuickBooks writes.
 */
import MonthlyReportView from '@/apps/auto-sales/ui/MonthlyReportView'

export const dynamic = 'force-dynamic'

export default async function AutoSalesReportPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { month } = await searchParams
  return <MonthlyReportView month={month} />
}

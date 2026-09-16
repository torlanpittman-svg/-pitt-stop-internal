/**
 * Auto Sales — Monthly report PRINT view (ADMIN; gated by proxy.ts /admin/*). Same computed report,
 * light-on-white print layout for the accountant package. Open in a new tab and print to PDF.
 */
import MonthlyReportView from '@/apps/auto-sales/ui/MonthlyReportView'

export const dynamic = 'force-dynamic'

export default async function AutoSalesReportPrintPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { month } = await searchParams
  return <MonthlyReportView month={month} print />
}

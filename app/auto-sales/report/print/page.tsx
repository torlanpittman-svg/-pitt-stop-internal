/**
 * Auto Sales — Monthly report PRINT view (MANAGER surface). Same manager gate as the report page; light-
 * on-white print layout for the accountant package. Open in a new tab and print to PDF. No QuickBooks writes.
 */
import { redirect } from 'next/navigation'
import { authorizedManager } from '@/apps/auth/employee-guard'
import MonthlyReportView from '@/apps/auto-sales/ui/MonthlyReportView'

export const dynamic = 'force-dynamic'

export default async function AutoSalesReportPrintPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  if (!(await authorizedManager())) redirect('/auto-sales')
  const { month } = await searchParams
  return <MonthlyReportView month={month} print />
}

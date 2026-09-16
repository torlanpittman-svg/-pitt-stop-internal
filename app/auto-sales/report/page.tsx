/**
 * Auto Sales — Monthly accountant report (MANAGER surface). Lives under /auto-sales/* (the employee
 * operational surface gated by the shop-PIN session in proxy.ts) and is additionally MANAGER-gated at
 * the route: a manager PIN (Torlan/Darryl/Tony/Bart) or admin Basic-Auth may view it — NOT ordinary
 * employees, who are redirected to inventory. This keeps manager reporting off the ADMIN_PASSWORD gate
 * while the /admin boundary is unchanged. No QuickBooks writes.
 */
import { redirect } from 'next/navigation'
import { authorizedManager } from '@/apps/auth/employee-guard'
import MonthlyReportView from '@/apps/auto-sales/ui/MonthlyReportView'

export const dynamic = 'force-dynamic'

export default async function AutoSalesReportPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  if (!(await authorizedManager())) redirect('/auto-sales')
  const { month } = await searchParams
  return <MonthlyReportView month={month} />
}

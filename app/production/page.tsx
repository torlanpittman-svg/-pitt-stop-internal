/**
 * /production — Daily Production Log (manager-elevation-gated operational report).
 * Server-gates on the identity/elevation cookies; employees are redirected home.
 */
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { parseActor, verifyElevation, effectiveRole } from '@/apps/workflow/identity'
import { completionEnabled } from '@/apps/workflow/completion'
import { dailyProduction, shopToday } from '@/apps/workflow/production'
import ProductionClient from './ProductionClient'

export const dynamic = 'force-dynamic'

export default async function ProductionPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  if (!completionEnabled()) redirect('/')
  const c = await cookies()
  const role = effectiveRole(parseActor(c.get('ps_actor')?.value), verifyElevation(c.get('ps_elev')?.value))
  if (role !== 'manager' && role !== 'admin') redirect('/')

  const today = shopToday()
  // Selected date is URL-backed (?date=YYYY-MM-DD) → refresh, back/forward, and copy-URL
  // all preserve it. Read-only: viewing a date never mutates anything.
  const sp = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : today
  const data = await dailyProduction(date)
  return <ProductionClient data={data} today={today} date={date} />
}

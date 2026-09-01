/**
 * /production — Production Log (daily + Mon–Sat weekly). The page is behind the shared employee session
 * (proxy.ts), so any authenticated employee can VIEW the operational production report (read-only). The
 * manager-only WRITE (production-date override) stays enforced at its own endpoint (403), not here.
 */
import { redirect } from 'next/navigation'
import { completionEnabled } from '@/apps/workflow/completion'
import { dailyProduction, weeklyProduction, shopToday } from '@/apps/workflow/production'
import ProductionClient from './ProductionClient'

export const dynamic = 'force-dynamic'

export default async function ProductionPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  if (!completionEnabled()) redirect('/')

  const today = shopToday()
  // Selected date is URL-backed (?date=YYYY-MM-DD) → refresh, back/forward, and copy-URL
  // all preserve it. Read-only: viewing a date/week never mutates anything.
  const sp = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : today
  const [data, week] = await Promise.all([dailyProduction(date), weeklyProduction(date)])
  return <ProductionClient data={data} week={week} today={today} date={date} />
}

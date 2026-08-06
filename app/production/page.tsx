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

export default async function ProductionPage() {
  if (!completionEnabled()) redirect('/')
  const c = await cookies()
  const role = effectiveRole(parseActor(c.get('ps_actor')?.value), verifyElevation(c.get('ps_elev')?.value))
  if (role !== 'manager' && role !== 'admin') redirect('/')

  const today = shopToday()
  const initial = await dailyProduction(today)
  return <ProductionClient initial={initial} today={today} />
}

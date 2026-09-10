/**
 * /checks — Write a Check (manager-only, mobile-first). Server component: verifies the manager identity,
 * loads readiness + the next check number per bank, then renders the client flow. If the feature is not
 * configured yet it shows exactly what the owner still needs to set up (never a broken form).
 */
import { redirect } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { getCheckConfig, checkConfigReadiness } from '@/apps/checks/config'
import { peekNextNumber } from '@/apps/checks/numbering'
import { CHECK_CATEGORIES } from '@/apps/checks/types'
import { listRecentChecks } from '@/apps/checks/db'
import WriteCheckFlow from './WriteCheckFlow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function ChecksPage() {
  const actor = await managerActor()
  if (!actor) redirect('/auto-sales/login?next=/checks')

  const cfg = await getCheckConfig()
  const readiness = checkConfigReadiness(cfg)
  const [nextOperating, nextAutoSales, recent] = await Promise.all([
    peekNextNumber('operating'),
    peekNextNumber('auto_sales'),
    listRecentChecks(15),
  ])

  return (
    <WriteCheckFlow
      actorName={actor.name}
      enabled={cfg.enabled}
      readiness={readiness}
      banks={cfg.banks}
      categories={CHECK_CATEGORIES.map((c) => ({ key: c.key, label: c.label, entity: c.entity, hint: c.hint, linksJob: 'linksJob' in c ? !!c.linksJob : false, linksVehicle: 'linksVehicle' in c ? !!c.linksVehicle : false }))}
      nextNumbers={{ operating: nextOperating, auto_sales: nextAutoSales }}
      recent={recent}
    />
  )
}

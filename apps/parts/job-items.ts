/**
 * Services vs Parts on a Job — one classification for the Job page, Work Board cards, and Finish Job.
 *
 * service_orders.services is the Job's employee-facing text list, and historically it carries BOTH work
 * and part labels (Quick Entry writes confirmed parts there; older estimate conversion copied every
 * approved line). The classification is never guessed from wording here: a label is a Part only when
 * a real record says so — a live job_parts row with that description, or an estimate line stored as
 * kind='part'. Everything else is work. Correcting a mis-typed line uses the estimate's existing
 * "convert to part" action (same row + price line), after which it moves to Parts everywhere.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { jobEstimates, jobServices } from '@/apps/workflow/schema'
import { jobParts } from './schema'
import { countJobParts, partKey } from './status'

export const itemKey = partKey   // same key promoteTextServices dedupes on

export interface JobItems {
  /** Work to perform (Services list / card chips / the Finish Job gate). */
  services: string[]
  /** Labels from the Job's list that are parts (shown under Parts, never as services). */
  partLabels: string[]
  /** Labels from partLabels that are CURRENT parts (a name whose tracked parts are all cancelled is dropped). */
  activePartLabels: string[]
  /** Displayed Parts count (countJobParts — the one rule for Job page + Work Board): live tracked parts plus
   *  untracked part labels, cancelled never counted; `waiting` = tracked parts still outstanding. */
  parts: { total: number; waiting: number }
}

/** Pure split of the Job's text list against the known part keys (order preserved). */
export function splitJobItems(text: readonly string[] | null | undefined, partKeys: ReadonlySet<string>): { services: string[]; partLabels: string[] } {
  const services: string[] = []
  const partLabels: string[] = []
  for (const raw of text ?? []) {
    const label = (raw ?? '').trim()
    if (!label) continue
    ;(partKeys.has(itemKey(label)) ? partLabels : services).push(raw)
  }
  return { services, partLabels }
}

/** Batch loader for the Work Board and the Job page. */
export async function loadJobItems(orders: readonly { id: string; services: string[] | null }[]): Promise<Map<string, JobItems>> {
  const out = new Map<string, JobItems>()
  if (orders.length === 0) return out
  const ids = orders.map((o) => o.id)
  const db = getDb()
  const [partRows, partLines] = await Promise.all([
    db.select({ orderId: jobParts.serviceOrderId, description: jobParts.description, status: jobParts.status })
      // All statuses: a cancelled part still names a Part (it never moves back into Services); the count
      // rule below excludes it.
      .from(jobParts).where(inArray(jobParts.serviceOrderId, ids)),
    db.select({ orderId: jobEstimates.serviceOrderId, title: jobServices.title })
      .from(jobServices).innerJoin(jobEstimates, eq(jobEstimates.id, jobServices.jobEstimateId))
      .where(and(inArray(jobEstimates.serviceOrderId, ids), eq(jobServices.kind, 'part'))),
  ])
  const keys = new Map<string, Set<string>>()
  const byOrder = new Map<string, { description: string; status: string }[]>()
  for (const p of partRows) {
    ;(keys.get(p.orderId) ?? keys.set(p.orderId, new Set()).get(p.orderId)!).add(itemKey(p.description))
    ;(byOrder.get(p.orderId) ?? byOrder.set(p.orderId, []).get(p.orderId)!).push(p)
  }
  for (const l of partLines) (keys.get(l.orderId) ?? keys.set(l.orderId, new Set()).get(l.orderId)!).add(itemKey(l.title))
  for (const o of orders) {
    const split = splitJobItems(o.services, keys.get(o.id) ?? new Set())
    const { total, waiting, activeLabels } = countJobParts(split.partLabels, byOrder.get(o.id) ?? [])
    out.set(o.id, { ...split, activePartLabels: activeLabels, parts: { total, waiting } })
  }
  return out
}

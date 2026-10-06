/**
 * Campaign status machine. Transitions are explicit and one-directional where it matters so a
 * double-tap or a stale UI can't, say, re-open a Sent campaign or send a Draft. `cancelled` and
 * `completed` are terminal. Pure + testable; the DB layer calls canTransition() before writing.
 */
import type { CampaignStatus } from './types'

const ALLOWED: Record<CampaignStatus, CampaignStatus[]> = {
  draft:     ['ready', 'cancelled'],
  ready:     ['scheduled', 'sending', 'draft', 'cancelled'],
  scheduled: ['sending', 'ready', 'cancelled'],
  sending:   ['sent', 'paused'],
  paused:    ['sending', 'cancelled'],
  sent:      ['completed'],
  completed: [],
  cancelled: [],
}

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

export function allowedTransitions(from: CampaignStatus): CampaignStatus[] {
  return ALLOWED[from] ?? []
}

export function isTerminal(status: CampaignStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

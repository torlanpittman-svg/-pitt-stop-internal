/**
 * Facebook comment / message assistant. V1 classifies an inbound message, SUGGESTS a reply for safe
 * topics (hours, location, services, "do you work on trucks?", stain questions, how to get an
 * estimate), and ESCALATES anything risky to a manager instead of answering autonomously. It never
 * fabricates a price for condition-dependent work and never auto-sends — a manager reviews the queue.
 */
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { marketingConversations } from './schema'
import { MARKETING_PROFILE } from './profile'
import { logEvent } from './events'

export type ConversationState = 'new' | 'suggested' | 'needs_review' | 'escalated' | 'answered' | 'archived'

export interface CommentClassification {
  topic: string | null
  suggestedReply: string | null
  escalate: boolean
  escalationReason: string | null
  state: ConversationState
}

// Escalate — never answer these autonomously.
const ESCALATION_RULES: Array<{ reason: string; re: RegExp }> = [
  { reason: 'refund_request', re: /\b(refund|money\s+back|chargeback|charge\s*back)\b/i },
  { reason: 'damage_claim', re: /\b(damage[ds]?|scratched\s+my|ruined|broke|messed\s+up|dent)\b/i },
  { reason: 'legal_threat', re: /\b(lawyer|attorney|sue|lawsuit|legal\s+action|bbb|better\s+business)\b/i },
  { reason: 'angry_complaint', re: /\b(terrible|worst|awful|scam|rip\s*off|ripoff|never\s+again|furious|disgusting)\b/i },
  { reason: 'fleet_commercial', re: /\b(fleet|commercial|dealership|our\s+trucks|multiple\s+vehicles|\d{2,}\s+vehicles)\b/i },
]

const FAQ = MARKETING_PROFILE.faqs

// Topic matchers → FAQ key. Order matters (price/estimate before generic service words).
const TOPIC_RULES: Array<{ topic: string; faqKey: string; re: RegExp }> = [
  { topic: 'hours', faqKey: 'hours', re: /\b(hours?|open|closed|what\s+time)\b/i },
  { topic: 'location', faqKey: 'location', re: /\b(where|located|address|directions|location)\b/i },
  { topic: 'trucks', faqKey: 'trucks', re: /\b(trucks?|f-?\d{2,3}|silverado|suvs?|tahoe|lifted|diesel)\b/i },
  { topic: 'ceramic', faqKey: 'ceramic', re: /\bceramic\b/i },
  { topic: 'paint_correction', faqKey: 'paint_correction', re: /\b(swirls?|paint\s*correction|oxidation|buff|polish|haze)\b/i },
  { topic: 'stains', faqKey: 'stains', re: /\b(stains?|odor|smell|pet\s*hair|vomit|spill|mold)\b/i },
  { topic: 'estimate', faqKey: 'estimate', re: /\b(estimate|quote|book|appointment|schedule)\b/i },
]

// A price question for a specific vehicle → never quote blind; invite photos.
const PRICE_RE = /\b(how\s+much|price|cost|charge|\$\d+)\b/i

function faqAnswer(key: string): string | null {
  return FAQ.find((f) => f.q === key)?.a ?? null
}

/** Pure classifier — no DB. Decides topic, a safe suggested reply, and whether to escalate. */
export function classifyComment(message: string): CommentClassification {
  const text = (message ?? '').trim()
  if (!text) return { topic: null, suggestedReply: null, escalate: false, escalationReason: null, state: 'needs_review' }

  for (const rule of ESCALATION_RULES) {
    if (rule.re.test(text)) {
      return { topic: rule.reason, suggestedReply: null, escalate: true, escalationReason: rule.reason, state: 'escalated' }
    }
  }

  // A blind price question is answered with the condition-dependent estimate language (never a number).
  if (PRICE_RE.test(text)) {
    return {
      topic: 'pricing', state: 'suggested', escalate: false, escalationReason: null,
      suggestedReply: "Pricing depends on the condition and what you're looking to accomplish. Send us a few photos or your phone number and your year/make/model, and we can get you a much tighter estimate.",
    }
  }

  for (const rule of TOPIC_RULES) {
    if (rule.re.test(text)) {
      const answer = faqAnswer(rule.faqKey)
      if (answer) return { topic: rule.topic, suggestedReply: answer, escalate: false, escalationReason: null, state: 'suggested' }
    }
  }

  // No confident topic → queue for a human, don't guess.
  return { topic: null, suggestedReply: null, escalate: false, escalationReason: null, state: 'needs_review' }
}

export type Conversation = typeof marketingConversations.$inferSelect

/** Ingest an inbound comment/message, classify it, and queue it with a suggestion/escalation. */
export async function ingestComment(input: { platform?: string; externalRef?: string | null; authorName?: string | null; message: string }, actor: string | null = null): Promise<Conversation> {
  const c = classifyComment(input.message)
  const [row] = await getDb().insert(marketingConversations).values({
    platform: input.platform ?? 'facebook',
    externalRef: input.externalRef ?? null,
    authorName: input.authorName ?? null,
    message: input.message,
    topic: c.topic,
    suggestedReply: c.suggestedReply,
    state: c.state,
    escalationReason: c.escalationReason,
  }).returning()
  if (c.escalate) await logEvent('conversation_escalated', { entityType: 'conversation', entityId: row.id, actor, meta: { reason: c.escalationReason } })
  else if (c.suggestedReply) await logEvent('reply_suggested', { entityType: 'conversation', entityId: row.id, actor, meta: { topic: c.topic } })
  return row
}

export async function listConversations(state?: ConversationState, limit = 100): Promise<Conversation[]> {
  const db = getDb()
  const q = db.select().from(marketingConversations).orderBy(desc(marketingConversations.createdAt)).limit(limit)
  return state ? q.where(eq(marketingConversations.state, state)) : q
}

export async function updateConversation(id: string, patch: { suggestedReply?: string | null; state?: ConversationState; handledBy?: string | null }, actor: string | null): Promise<Conversation | null> {
  const [row] = await getDb().update(marketingConversations).set({ ...patch, updatedAt: new Date() }).where(eq(marketingConversations.id, id)).returning()
  if (row && patch.state) await logEvent('reply_suggested', { entityType: 'conversation', entityId: id, actor, meta: { state: patch.state } })
  return row ?? null
}

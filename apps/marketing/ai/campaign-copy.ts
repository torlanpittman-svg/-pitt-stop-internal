/**
 * CampaignCopyGenerator — drafts SMS + email copy from Pitt Stop's brand knowledge (profile.ts).
 * The draft ALWAYS passes through guardrails (guardrails.ts) and ALWAYS requires manager approval
 * before a send. If the model is unavailable or returns malformed output, a deterministic template
 * draft is produced instead — the UI always gets a usable, on-brand draft, and nothing unsafe is
 * ever written.
 */
import { z } from 'zod'
import { MARKETING_PROFILE, brandContext, serviceKnowledge } from '../profile'
import { validateCampaignCopy, type GuardrailResult } from '../guardrails'
import { SERVICE_CATEGORY_LABELS, type ServiceCategory } from '../types'
import { aiConfigured, generateStructured, type RawCompletion } from './client'

export interface CopyRequest {
  targetService: ServiceCategory
  segmentLabel: string
  channel: 'sms' | 'email' | 'both'
  offer?: string | null
  offerApproved?: boolean
}

export interface CampaignCopy {
  smsCopy: string
  emailSubject: string
  emailBody: string
  targetService: string
  reasoningSummary: string
  warnings: string[]
}

export interface CopyDraftResult {
  copy: CampaignCopy
  source: 'ai' | 'template'
  guardrail: GuardrailResult
}

const CopySchema = z.object({
  smsCopy: z.string().min(1).max(480),
  emailSubject: z.string().min(1).max(160),
  emailBody: z.string().min(1).max(2000),
  targetService: z.string().max(40),
  reasoningSummary: z.string().max(600).default(''),
  warnings: z.array(z.string().max(200)).max(10).default([]),
})

function systemPrompt(): string {
  return [
    'You are the marketing copywriter for a premium auto-detailing shop.',
    brandContext(),
    'Write copy that sounds local, knowledgeable, and professional — never spammy, never hype.',
    'Personalization tokens you MAY use: {{name}} and {{vehicle}} (they are filled in per customer).',
    'Return JSON: {"smsCopy","emailSubject","emailBody","targetService","reasoningSummary","warnings"}.',
    'SMS must be concise and include a soft call to reply. Email body is 2-4 short sentences.',
    'Never invent a discount or a guarantee. Invite a photo/inspection for condition-dependent work.',
  ].join('\n')
}

function userPrompt(req: CopyRequest): string {
  const svc = serviceKnowledge(req.targetService)
  return [
    `Target service: ${SERVICE_CATEGORY_LABELS[req.targetService] ?? req.targetService}.`,
    svc ? `Service facts: ${svc.summary} Benefit: ${svc.benefit}` : '',
    `Audience segment: ${req.segmentLabel}.`,
    `Channel(s): ${req.channel}.`,
    req.offer ? `Approved offer to mention: ${req.offer}` : 'No discount/offer — do not invent one.',
  ].filter(Boolean).join('\n')
}

/** Deterministic, on-brand fallback draft (no model required). */
export function templateCopy(req: CopyRequest): CampaignCopy {
  const svc = serviceKnowledge(req.targetService)
  const name = SERVICE_CATEGORY_LABELS[req.targetService] ?? 'detailing'
  const offerLine = req.offer ? ` ${req.offer}.` : ''
  const sms = req.targetService === 'ceramic'
    ? `Hi {{name}} — since we've worked on your {{vehicle}} before, ceramic coating may be worth considering for longer-term protection and easier maintenance. We can inspect it and tell you honestly if it makes sense.${offerLine} Reply to set up a look.`
    : req.targetService === 'paint_correction'
    ? `Hi {{name}} — if the outside of your {{vehicle}} has picked up swirls or lost gloss, we can inspect the paint and tell you what level of correction would make sense.${offerLine} Reply with a few photos if you'd like us to take a look.`
    : req.targetService === 'interior'
    ? `Hi {{name}} — if your {{vehicle}}'s interior could use a reset, we have a few detail openings coming up.${offerLine} Reply and we'll help you figure out what it needs.`
    : `Hi {{name}} — we haven't seen your {{vehicle}} in a while. If it's due for a reset, we have a few openings coming up.${offerLine} Reply and we'll get you set.`
  return {
    smsCopy: sms,
    emailSubject: req.targetService === 'ceramic' ? 'Worth protecting your {{vehicle}}?' : `Is your {{vehicle}} due for ${name.toLowerCase()}?`,
    emailBody: `Hi {{name}},\n\n${svc?.summary ?? 'We keep vehicles looking their best with premium detailing.'} ${svc?.benefit ?? ''}\n\nIf you'd like, reply with a few photos or your year/make/model and we'll tell you honestly what makes sense for your {{vehicle}}.${offerLine}\n\n— ${MARKETING_PROFILE.shortName}`,
    targetService: req.targetService,
    reasoningSummary: 'Deterministic template (model unavailable or declined). On-brand, no invented offer.',
    warnings: [],
  }
}

/** Generate a campaign-copy draft. Injectable `complete` makes this testable without a network. */
export async function generateCampaignCopy(
  req: CopyRequest,
  opts: { complete?: RawCompletion } = {},
): Promise<CopyDraftResult> {
  const offerApproved = req.offerApproved ?? !!req.offer
  const runGuardrails = (copy: CampaignCopy): GuardrailResult =>
    validateCampaignCopy({ smsCopy: copy.smsCopy, emailSubject: copy.emailSubject, emailBody: copy.emailBody }, { offerApproved })

  // No model configured and nothing injected → deterministic template.
  if (!opts.complete && !aiConfigured()) {
    const copy = templateCopy(req)
    return { copy, source: 'template', guardrail: runGuardrails(copy) }
  }

  const result = await generateStructured(CopySchema, systemPrompt(), userPrompt(req), opts.complete)
  if (!result.ok) {
    const copy = templateCopy(req)
    copy.warnings = [...copy.warnings, `AI draft unavailable (${result.error}); used a template.`]
    return { copy, source: 'template', guardrail: runGuardrails(copy) }
  }

  const guardrail = runGuardrails(result.data)
  // If the model produced a brand-safety ERROR, fall back to the safe template rather than surface it.
  if (!guardrail.ok) {
    const copy = templateCopy(req)
    copy.warnings = [...copy.warnings, 'AI draft failed brand guardrails; used a safe template instead.']
    return { copy, source: 'template', guardrail: runGuardrails(copy) }
  }
  return {
    copy: { ...result.data, warnings: [...result.data.warnings, ...guardrail.findings.map((f) => f.message)] },
    source: 'ai',
    guardrail,
  }
}

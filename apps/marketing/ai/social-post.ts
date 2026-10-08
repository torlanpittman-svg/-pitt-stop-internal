/**
 * SocialPostGenerator — drafts a Facebook post for a content pillar (educate/proof/sell) and premium
 * service, optionally grounded in a real completed job (vehicle + service performed). Same safety
 * contract as campaign copy: validated, guardrailed, manager-approved before posting, deterministic
 * template fallback. We only ever describe the service that was actually performed.
 */
import { z } from 'zod'
import { brandContext, serviceKnowledge } from '../profile'
import { validateCopy, type GuardrailResult } from '../guardrails'
import { SERVICE_CATEGORY_LABELS, type ContentPillar, type ServiceCategory } from '../types'
import { aiConfigured, generateStructured, type RawCompletion } from './client'

export interface PostRequest {
  pillar: ContentPillar
  targetService: ServiceCategory
  vehicle?: string | null
  servicePerformed?: string | null
}

export interface SocialPostCopy {
  copy: string
  targetService: string
  reasoningSummary: string
  warnings: string[]
}

export interface PostDraftResult {
  post: SocialPostCopy
  source: 'ai' | 'template'
  guardrail: GuardrailResult
}

const PostSchema = z.object({
  copy: z.string().min(1).max(1500),
  targetService: z.string().max(40),
  reasoningSummary: z.string().max(600).default(''),
  warnings: z.array(z.string().max(200)).max(10).default([]),
})

function systemPrompt(): string {
  return [
    'You are the social content writer for a premium auto-detailing shop.',
    brandContext(),
    'Write ONE Facebook post. No hashtags spam, at most one emoji, no fake urgency.',
    'educate = teach something; proof = describe a real job factually; sell = clear, calm call to action.',
    'Return JSON: {"copy","targetService","reasoningSummary","warnings"}.',
    // Hard safety: never invent results/conditions that were not supplied.
    'NEVER state results, outcomes, or vehicle conditions that were not explicitly provided. Do NOT say paint',
    'was restored, swirls/oxidation were removed, or gloss was brought back unless that exact service was given',
    'as "service performed". If a vehicle is given, you may name the vehicle and the service performed, nothing',
    'more. If no service performed is supplied, educate about the service and invite an estimate instead of',
    'claiming any outcome. Always invite year/make/model or photos for an estimate.',
  ].join('\n')
}

function userPrompt(req: PostRequest): string {
  const svc = serviceKnowledge(req.targetService)
  return [
    `Pillar: ${req.pillar}.`,
    `Service: ${SERVICE_CATEGORY_LABELS[req.targetService] ?? req.targetService}.`,
    svc ? `Service facts (general, not a claim about any specific job): ${svc.summary} Benefit: ${svc.benefit}` : '',
    req.vehicle ? `Real job vehicle: ${req.vehicle}.` : '',
    req.servicePerformed
      ? `Service actually performed on this vehicle: ${req.servicePerformed}. Describe only this — no other outcomes.`
      : 'No specific service outcome was supplied — do NOT claim any result; educate and invite an estimate.',
  ].filter(Boolean).join('\n')
}

export function templatePost(req: PostRequest): SocialPostCopy {
  const svc = serviceKnowledge(req.targetService)
  const label = SERVICE_CATEGORY_LABELS[req.targetService] ?? req.targetService
  const v = req.vehicle?.trim()
  const performed = req.servicePerformed?.trim()
  let copy: string
  if (req.pillar === 'proof' && v && performed) {
    // Factual ONLY: the vehicle + the service that was actually performed. No unobserved results.
    copy = `${v} — ${performed} at Pitt Stop.\n\nWant the same for your vehicle? Send your year/make/model or a few photos and we'll get you a tight estimate.`
  } else if (req.pillar === 'proof') {
    // No confirmed outcome ⇒ do NOT claim a result. Educate about the service + invite an estimate.
    copy = `${label} at Pitt Stop.\n\n${[svc?.summary, svc?.benefit].filter(Boolean).join(' ')}\n\nWant to know if it's right for your vehicle? Send your year/make/model or a few photos and we'll tell you honestly.`
  } else if (req.pillar === 'educate') {
    copy = req.targetService === 'paint_correction'
      ? `If your paint looks great in the shade but shows swirls under sunlight, that's usually something paint correction can improve.\n\nCorrection machine-polishes the paint you already have. Want to know what your vehicle would need? Send a few photos.`
      : `${[svc?.summary, svc?.benefit].filter(Boolean).join(' ')}\n\nNot sure if it's right for your vehicle? Send your year/make/model and we'll tell you honestly.`
  } else {
    copy = `${label} done right.\n\n${svc?.benefit ?? ''} Reply or send a few photos of your vehicle and we'll get you a tight estimate.`
  }
  return { copy: copy.replace(/\n{3,}/g, '\n\n').trim(), targetService: req.targetService, reasoningSummary: 'Deterministic template (model unavailable or declined).', warnings: [] }
}

export async function generateSocialPost(req: PostRequest, opts: { complete?: RawCompletion } = {}): Promise<PostDraftResult> {
  if (!opts.complete && !aiConfigured()) {
    const post = templatePost(req)
    return { post, source: 'template', guardrail: validateCopy(post.copy) }
  }
  const result = await generateStructured(PostSchema, systemPrompt(), userPrompt(req), opts.complete)
  if (!result.ok) {
    const post = templatePost(req)
    post.warnings = [`AI draft unavailable (${result.error}); used a template.`]
    return { post, source: 'template', guardrail: validateCopy(post.copy) }
  }
  const guardrail = validateCopy(result.data.copy)
  if (!guardrail.ok) {
    const post = templatePost(req)
    post.warnings = ['AI draft failed brand guardrails; used a safe template instead.']
    return { post, source: 'template', guardrail: validateCopy(post.copy) }
  }
  return { post: { ...result.data, warnings: [...result.data.warnings, ...guardrail.findings.map((f) => f.message)] }, source: 'ai', guardrail }
}

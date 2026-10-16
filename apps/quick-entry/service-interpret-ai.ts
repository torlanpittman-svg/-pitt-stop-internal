/**
 * Service-entry interpretation — AI pass (OpenAI GPT-4o, the same provider/key as the Quick Entry
 * NL interpreter in interpret-ai.ts). Runs only when the deterministic core found no established
 * match. It UNDERSTANDS rushed wording; it does not decide authorized work:
 *   - it may only pick catalog items by their index in the list we send (validated server-side);
 *   - an area/component or part description is accepted only when every word is grounded in the
 *     employee's own (corrected) entry — nothing invented;
 *   - the response schema has no price, quantity, tax, or description fields, and any extra keys
 *     are ignored.
 * Fails soft: no key / timeout / bad JSON → { status: 'unavailable' | 'failed' }, and the caller
 * keeps the entry and the deterministic candidates for manual selection.
 */
import OpenAI from 'openai'
import { isGrounded, tokenize, MAX_CANDIDATES, type Interpretation, type InterpretCatalogItem } from './service-interpret'

export interface AiCatalogEntry { item: InterpretCatalogItem; description: string | null }

export type AiOutcome =
  | { status: 'used'; catalogIds: string[]; intent: 'service' | 'part' | 'odor' | 'unclear'; area: string | null; partDescription: string | null; question: string | null }
  | { status: 'unavailable' | 'failed'; reason: string }

export function serviceAiConfigured(): boolean { return !!process.env.OPENAI_API_KEY }

export const SERVICE_AI_MODEL = 'gpt-4o'
const TIMEOUT_MS = 9000

const SYSTEM = `You help an auto detailing shop understand a rushed, misspelled, abbreviated employee entry for ONE line of work.
You are given the employee's entry, a corrected reading of it, and a numbered list of the shop's existing services.
Return JSON only:
{"intent":"service|part|odor|unclear","choices":[<up to 3 service numbers, most likely first>],"area":"<location/component words or empty>","partDescription":"<physical part words or empty>","question":"<one short question or empty>"}
Rules:
- "choices" are numbers from the list ONLY. Pick services whose described work matches what the employee asked for. Empty if nothing fits. Never pick a service just because it shares a word.
- "area" is the job-specific location or component (e.g. "passenger seat", "driver-side mirror assembly"), using ONLY words from the entry/corrected reading (you may add "side").
- intent "part" when the entry names a physical part to supply/replace with no work verb (e.g. "dr side mirror assy"); then put the part words in "partDescription" (entry words only). A verb like paint/clean/shampoo means a service performed ON the component.
- intent "odor" for smell/odor requests that do not say which treatment.
- "question" only when two or more scopes are genuinely plausible; keep it under 12 words.
- NEVER output prices, quantities, tax, descriptions, or services that are not in the list.`

/** Parse + validate the model's JSON against the list we sent. Pure (exported for tests). */
export function parseAiResponse(content: string, list: AiCatalogEntry[], correctedTokens: string[]): AiOutcome {
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(content) as Record<string, unknown> } catch { return { status: 'failed', reason: 'AI returned invalid JSON' } }
  if (!parsed || typeof parsed !== 'object') return { status: 'failed', reason: 'AI returned no object' }
  const rawChoices = Array.isArray(parsed.choices) ? parsed.choices : []
  const ids: string[] = []
  for (const c of rawChoices) {
    const n = typeof c === 'number' ? c : Number.parseInt(String(c), 10)
    const entry = Number.isInteger(n) ? list[n - 1] : undefined   // list is 1-based in the prompt
    if (entry && !ids.includes(entry.item.id)) ids.push(entry.item.id)
    if (ids.length >= MAX_CANDIDATES) break
  }
  const intentRaw = String(parsed.intent ?? '')
  const intent = (['service', 'part', 'odor', 'unclear'] as const).find((i) => i === intentRaw) ?? 'unclear'
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120) : '')
  const area = clean(parsed.area)
  const partDescription = clean(parsed.partDescription)
  const question = typeof parsed.question === 'string' ? parsed.question.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  return {
    status: 'used', catalogIds: ids, intent,
    area: area && isGrounded(area, correctedTokens) ? area : null,
    partDescription: partDescription && isGrounded(partDescription, correctedTokens) ? partDescription : null,
    question: question || null,
  }
}

export async function aiInterpret(entry: string, corrected: string, list: AiCatalogEntry[], client?: Pick<OpenAI, 'chat'>): Promise<AiOutcome> {
  if (!client && !serviceAiConfigured()) return { status: 'unavailable', reason: 'OPENAI_API_KEY is not configured' }
  if (list.length === 0) return { status: 'failed', reason: 'no eligible catalog items' }
  const ai = client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 0 })
  const catalog = list.map((e, i) => `${i + 1}. ${e.item.name}${e.description ? ` — ${e.description.slice(0, 140)}` : ''}`).join('\n')
  const user = `Employee entry: ${JSON.stringify(entry)}\nCorrected reading: ${JSON.stringify(corrected)}\n\nServices:\n${catalog}`
  try {
    const res = await ai.chat.completions.create({
      model: SERVICE_AI_MODEL, temperature: 0, response_format: { type: 'json_object' }, max_tokens: 200,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    }, { timeout: TIMEOUT_MS })
    return parseAiResponse(res.choices[0]?.message?.content ?? '', list, tokenize(corrected))
  } catch (err) {
    return { status: 'failed', reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
  }
}

/**
 * Merge the AI outcome into the deterministic interpretation. Established matches and the odor/tire
 * rules are never overridden. AI candidates go first (they read the whole entry), deterministic
 * keyword candidates follow; the result still requires the user's confirmation.
 */
export function mergeAiInterpretation(det: Interpretation, ai: AiOutcome, eligibleIds: Set<string>): Interpretation {
  if (ai.status !== 'used' || det.status === 'resolved' || det.intent === 'odor' || det.intent === 'tires') return det
  const out: Interpretation = { ...det, candidates: [...det.candidates] }
  if (!out.area && ai.area) out.area = ai.area
  if (ai.intent === 'part' && ai.partDescription && (det.intent === 'service' || det.intent === 'unknown')) {
    out.intent = 'part'
    out.part = { description: ai.partDescription[0].toUpperCase() + ai.partDescription.slice(1) }
    out.question = out.question ?? 'This looks like a part. Add it as a part (then review installation labor)?'
  }
  if (out.intent !== 'part') {
    const aiCands = ai.catalogIds.filter((id) => eligibleIds.has(id)).map((id) => ({ catalogId: id, via: 'ai' as const }))
    const seen = new Set<string>()
    out.candidates = [...aiCands, ...det.candidates].filter((c) => (seen.has(c.catalogId) ? false : (seen.add(c.catalogId), true))).slice(0, MAX_CANDIDATES)
    if (aiCands.length) out.source = 'ai'
  }
  if (!out.question && ai.question && out.candidates.length > 1) out.question = ai.question
  out.status = out.candidates.length > 0 || out.part ? 'choose' : 'none'
  if (out.intent === 'unknown' && out.candidates.length) out.intent = 'service'
  return out
}

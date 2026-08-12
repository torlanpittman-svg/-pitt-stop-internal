/**
 * Quick Entry NL interpreter — AI pass (OpenAI GPT-4o). ONLY classifies the phrases
 * the deterministic core couldn't match: semantic match to an EXACT catalog title,
 * billable "custom" work, or an internal "note". Constrained hard against inventing
 * catalog services or prices; the server re-validates every result. Degrades safely
 * to "custom" for every phrase when no key is configured or the call fails.
 */
import OpenAI from 'openai'

export type AiClassType = 'service' | 'custom' | 'note'
export interface AiClass { phrase: string; type: AiClassType; catalogTitle?: string; noteText?: string }

export function aiConfigured(): boolean { return !!process.env.OPENAI_API_KEY }

const SYSTEM = `You classify short auto-detailing shop phrases for a service ticket. For EACH input phrase, choose exactly one type:
- "service": it clearly means one of the catalog services. Include "catalogTitle" copied EXACTLY from the provided catalog list (e.g. "wash" -> "Exterior Wash"; "wax" -> "Exterior Wax"; "interior" -> "Interior Detail").
- "custom": it is billable work but is NOT in the catalog list.
- "note": it is an instruction or observation, not a purchasable service (e.g. "try to get the stain out of the passenger seat"); put a short cleaned instruction in "noteText".
Hard rules: NEVER output a catalogTitle that is not in the list. NEVER output prices or numbers. If unsure between service and custom, choose custom. Return ONE item per input phrase, in the same order.
Return JSON: {"items":[{"type":"service|custom|note","catalogTitle":"...","noteText":"..."}]}`

export async function classifyUnmatched(phrases: string[], catalogTitles: string[]): Promise<AiClass[]> {
  const fallback = (): AiClass[] => phrases.map((p) => ({ phrase: p, type: 'custom' as const }))
  if (phrases.length === 0) return []
  if (!process.env.OPENAI_API_KEY) return fallback()
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const user = `Catalog services:\n${catalogTitles.map((t) => `- ${t}`).join('\n')}\n\nPhrases (classify each, same order):\n${phrases.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
    const res = await client.chat.completions.create({
      model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    })
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as { items?: Array<{ type?: string; catalogTitle?: string; noteText?: string }> }
    const items = Array.isArray(parsed.items) ? parsed.items : []
    // Map by index (robust to the model rewording the phrase); missing → custom.
    return phrases.map((p, i) => {
      const it = items[i]
      const type: AiClassType = it?.type === 'service' ? 'service' : it?.type === 'note' ? 'note' : 'custom'
      return { phrase: p, type, catalogTitle: it?.catalogTitle, noteText: it?.noteText }
    })
  } catch {
    return fallback()
  }
}

/**
 * Marketing AI client. Reuses the app's existing OpenAI + GPT-4o pattern (see apps/estimator/ai,
 * apps/quick-entry/interpret-ai): temperature 0, response_format json_object, graceful degradation.
 * Every structured call is validated with zod BEFORE it can reach the DB — malformed model output
 * can never drive a write (it falls back to a deterministic template instead).
 *
 * The raw completion is injectable (RawCompletion) so generators are unit-testable without a network
 * or an API key, and so a missing OPENAI_API_KEY cleanly degrades to dev-mock drafts.
 */
import OpenAI from 'openai'
import type { ZodType } from 'zod'

export const MARKETING_AI_MODEL = 'gpt-4o'

export type RawCompletion = (system: string, user: string) => Promise<string>

let _client: OpenAI | null = null
function client(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 0 })
  return _client
}

export function aiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.OPENAI_API_KEY
}

/** The default live completion — JSON mode, deterministic. */
export const openAiCompletion: RawCompletion = async (system, user) => {
  const res = await client().chat.completions.create({
    model: MARKETING_AI_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  })
  return res.choices[0]?.message?.content ?? '{}'
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  return JSON.parse(cleaned)
}

export type StructuredResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Call the model, parse, and validate against a zod schema. One retry with a stricter instruction on
 * parse/validation failure, then a safe {ok:false}. NEVER returns unvalidated data.
 */
export async function generateStructured<T>(
  schema: ZodType<T>,
  system: string,
  user: string,
  complete: RawCompletion = openAiCompletion,
  retries = 1,
): Promise<StructuredResult<T>> {
  let lastError = 'unknown'
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await complete(system, attempt === 0 ? user : `${user}\n\nReturn ONLY a valid JSON object matching the schema. No prose, no markdown.`)
      const parsed = parseJson(raw)
      const result = schema.safeParse(parsed)
      if (result.success) return { ok: true, data: result.data }
      lastError = result.error.issues[0]?.message ?? 'schema_mismatch'
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, error: lastError }
}

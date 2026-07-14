import { NextResponse } from 'next/server'
import OpenAI from 'openai'

// Temporary diagnostic endpoint — remove after OCR is confirmed working
export async function GET() {
  const key = process.env.OPENAI_API_KEY
  const keyHint = key
    ? `set (starts with ${key.slice(0, 8)}..., length ${key.length})`
    : 'NOT SET'

  if (!key) {
    return NextResponse.json({ ok: false, keyHint, error: 'OPENAI_API_KEY is not set' })
  }

  try {
    const client = new OpenAI({ apiKey: key })
    // Simple non-vision call to verify auth and model access
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    })
    const text = response.choices[0]?.message?.content ?? '(empty)'
    return NextResponse.json({ ok: true, keyHint, model: response.model, response: text })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status = (err as { status?: number })?.status
    const code   = (err as { code?: string })?.code
    return NextResponse.json({ ok: false, keyHint, error: message, status, code }, { status: 200 })
  }
}

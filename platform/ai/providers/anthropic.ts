import type { VisionQueryOptions, VisionQueryResult } from '../index'

/**
 * Anthropic Claude Vision provider.
 * Requires: ANTHROPIC_API_KEY env var.
 * Activate by setting OCR_PROVIDER=anthropic.
 */
export async function queryWithAnthropic(
  _options: VisionQueryOptions
): Promise<VisionQueryResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local.')
  }
  throw new Error(
    'Anthropic vision provider not yet implemented. ' +
      'Implement in lib/ai/providers/anthropic.ts when ready to test.'
  )
}

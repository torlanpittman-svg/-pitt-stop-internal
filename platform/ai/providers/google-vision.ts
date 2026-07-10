import type { VisionQueryOptions, VisionQueryResult } from '../index'

/**
 * Google Cloud Vision provider.
 * Requires: GOOGLE_VISION_API_KEY env var.
 * Activate by setting OCR_PROVIDER=google-vision.
 */
export async function queryWithGoogleVision(
  _options: VisionQueryOptions
): Promise<VisionQueryResult> {
  if (!process.env.GOOGLE_VISION_API_KEY) {
    throw new Error('GOOGLE_VISION_API_KEY is not set. Add it to .env.local.')
  }
  throw new Error(
    'Google Vision provider not yet implemented. ' +
      'Implement in lib/ai/providers/google-vision.ts when ready to test.'
  )
}

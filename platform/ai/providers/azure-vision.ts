import type { VisionQueryOptions, VisionQueryResult } from '../index'

/**
 * Azure Computer Vision provider.
 * Requires: AZURE_VISION_KEY + AZURE_VISION_ENDPOINT env vars.
 * Activate by setting OCR_PROVIDER=azure-vision.
 */
export async function queryWithAzureVision(
  _options: VisionQueryOptions
): Promise<VisionQueryResult> {
  if (!process.env.AZURE_VISION_KEY || !process.env.AZURE_VISION_ENDPOINT) {
    throw new Error(
      'AZURE_VISION_KEY and AZURE_VISION_ENDPOINT are required. Add them to .env.local.'
    )
  }
  throw new Error(
    'Azure Vision provider not yet implemented. ' +
      'Implement in lib/ai/providers/azure-vision.ts when ready to test.'
  )
}

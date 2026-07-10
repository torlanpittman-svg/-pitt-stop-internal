/**
 * Platform AI vision layer.
 *
 * All apps that need to analyze an image call queryVision().
 * Each app supplies its own prompt and parses the content into its own
 * result type. Provider selection, auth, and API calls are handled here.
 *
 * Provider selection order:
 *   1. OCR_PROVIDER env var (explicit override)
 *   2. Auto-detect: first configured API key wins
 *   3. Fallback: "mock" (zero-config demo mode)
 */

export interface VisionQueryOptions {
  imageBase64: string
  mimeType: string
  prompt: string
}

export interface VisionQueryResult {
  content: string
  rawResponse: unknown
  providerName: string
}

type ProviderFn = (options: VisionQueryOptions) => Promise<VisionQueryResult>

const PROVIDERS: Record<string, () => Promise<ProviderFn>> = {
  openai:          async () => (await import('./providers/openai')).queryWithOpenAI,
  anthropic:       async () => (await import('./providers/anthropic')).queryWithAnthropic,
  'google-vision': async () => (await import('./providers/google-vision')).queryWithGoogleVision,
  'azure-vision':  async () => (await import('./providers/azure-vision')).queryWithAzureVision,
  mock:            async () => (await import('./providers/mock')).queryWithMock,
}

export const SUPPORTED_AI_PROVIDERS = Object.keys(PROVIDERS)

function resolveProviderName(): string {
  if (process.env.OCR_PROVIDER) return process.env.OCR_PROVIDER
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.GOOGLE_VISION_API_KEY) return 'google-vision'
  if (process.env.AZURE_VISION_KEY) return 'azure-vision'
  return 'mock'
}

export async function queryVision(options: VisionQueryOptions): Promise<VisionQueryResult> {
  const providerName = resolveProviderName()
  const loader = PROVIDERS[providerName]

  if (!loader) {
    throw new Error(
      `Unknown AI provider: "${providerName}". ` +
        `Set OCR_PROVIDER to one of: ${SUPPORTED_AI_PROVIDERS.join(', ')}`
    )
  }

  const fn = await loader()
  return fn(options)
}

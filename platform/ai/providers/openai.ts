import OpenAI from 'openai'
import type { VisionQueryOptions, VisionQueryResult } from '../index'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env.local to use real OCR.')
  }
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _client
}

export async function queryWithOpenAI(
  options: VisionQueryOptions
): Promise<VisionQueryResult> {
  const client = getClient()

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 512,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${options.mimeType};base64,${options.imageBase64}`,
              detail: 'high',
            },
          },
          {
            type: 'text',
            text: options.prompt,
          },
        ],
      },
    ],
  })

  const content = response.choices[0]?.message?.content ?? ''

  return {
    content,
    rawResponse: response,
    providerName: 'openai',
    modelName:    response.model,
  }
}

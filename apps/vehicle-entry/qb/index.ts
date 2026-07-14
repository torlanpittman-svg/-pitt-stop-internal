// Returns the active QB provider.
// Phase 1: mock. Phase 3: live QB (enabled only after explicit approval).

import { mockQBProvider } from './mock'
import type { QBProvider } from './types'

export function getQBProvider(): QBProvider {
  // Phase 3: add `if (process.env.QB_LIVE === 'true') return liveQBProvider`
  return mockQBProvider
}

export type { QBProvider }
export type { QBLine, QBInvoice } from './types'

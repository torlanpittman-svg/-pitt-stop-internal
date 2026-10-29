import { notFound } from 'next/navigation'
import PartsPreview from './PartsPreview'

export const dynamic = 'force-dynamic'

/**
 * NON-PRODUCTION preview of the Parts screenshot-import UI, rendered with the ACTUAL components and SYNTHETIC
 * fixture data (no production auth, DB, PartsTech, or OpenAI). It is HARD-GATED off in production so it can
 * never be mounted on the live app, and it adds NO reusable auth bypass. See scripts/parts-preview/README.md.
 */
export default function PartsPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <PartsPreview />
}

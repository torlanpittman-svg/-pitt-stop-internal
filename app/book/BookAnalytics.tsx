'use client'
/**
 * Google tag loader for the public booking chrome. Mounted by the shared /book layout (which
 * /quote re-exports) but gates itself to the exact public paths — the private token routes
 * (/book/a/<token>, /book/r/<token>) never load third-party analytics, so an access-bearing
 * token can never reach Google. All policy lives in ./analytics.ts; rendering nothing is
 * always safe because booking never depends on analytics.
 */
import Script from 'next/script'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { TAG_IDS, initBookAnalytics, isPublicAnalyticsPath, type AnalyticsWindow } from './analytics'

export default function BookAnalytics() {
  const pathname = usePathname()
  const enabled = TAG_IDS.length > 0 && isPublicAnalyticsPath(pathname)
  useEffect(() => {
    if (enabled) initBookAnalytics(TAG_IDS, window as unknown as AnalyticsWindow)
  }, [enabled])
  if (!enabled) return null
  return <Script src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(TAG_IDS[0])}`} strategy="afterInteractive" />
}

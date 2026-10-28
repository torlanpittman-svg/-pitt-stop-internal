/**
 * Honest provenance banner for Google Ads figures, shared by the overview, weekly report, and
 * Google Ads pages. Copy + severity are decided by the pure `adNoticeContent()` (so they're unit
 * tested); this component only maps that to accessible markup (role="status"/"alert") and tone
 * classes, so money tiles are never mistaken for real zeros.
 */
import { adNoticeContent } from '@/apps/marketing/ad-notice'
import type { AdDataMeta } from '@/apps/marketing/ads-reporting'

const TONE: Record<'live' | 'manual' | 'warn', string> = {
  live: 'border-emerald-600/40 bg-emerald-500/5 text-emerald-200',
  manual: 'border-amber-500/40 bg-amber-500/5 text-amber-200',
  warn: 'border-amber-500/50 bg-amber-500/10 text-amber-200',
}

export function AdDataNotice({ meta, className = '' }: { meta: AdDataMeta; className?: string }) {
  const c = adNoticeContent(meta)
  return (
    <div role={c.role} className={`rounded-xl border px-4 py-3 text-sm ${TONE[c.tone]} ${className}`}>
      <span className="font-semibold">{c.heading}</span> — {c.body}
    </div>
  )
}

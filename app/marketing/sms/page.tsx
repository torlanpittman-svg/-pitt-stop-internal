import { requireMarketingManager, MarketingShell, Section } from '../_components'
import { getMarketingConfig } from '@/apps/settings/db'
import { buildA2pPacket } from '@/apps/marketing/a2p'
import { Badge } from '@/app/components/ui/Badge'
import { CopyButton } from '@/app/components/CopyButton'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * SMS Launch is DEFERRED in V1 (owner decision 2026-10-08). No Twilio/A2P activation work happens now,
 * and marketing dispatch forces dry-run regardless of settings. This page is intentionally NOT in the
 * primary nav; it's kept reachable by direct link as a deferred notice + a read-only A2P reference so
 * none of the earlier registration work is lost when SMS is picked up later.
 */
export default async function SmsLaunchPage() {
  await requireMarketingManager('/marketing/sms')
  const cfg = await getMarketingConfig()
  const packet = buildA2pPacket(cfg)

  return (
    <MarketingShell active="/marketing/sms" title="SMS — Deferred">
      <div className="mb-5 rounded-2xl border border-amber-700/60 bg-amber-950/40 p-4">
        <div className="flex items-center gap-2">
          <Badge tone="warn">DEFERRED</Badge>
          <span className="text-sm font-semibold text-white">Text messaging is not active and cannot be turned on from here.</span>
        </div>
        <p className="mt-2 text-sm text-amber-200/90">
          Outbound SMS is deferred until a later phase. Marketing campaigns remain <span className="font-semibold">draft &amp; preview only</span>:
          building recipients and &ldquo;Send&rdquo; produce a dry-run preview — nothing is ever texted, regardless of settings or
          environment credentials. No Twilio onboarding or A2P registration is being pursued right now.
        </p>
        <p className="mt-2 text-xs text-amber-200/70">
          The Twilio provider, consent model, opt-in page and A2P packet code are preserved for when SMS is picked up again.
          Email is also not a live channel in V1 (Pitt Stop&apos;s only real email is QuickBooks-native).
        </p>
      </div>

      <Section title="A2P 10DLC reference packet (for a future activation pass)" right={<CopyButton value={packet.campaign.description} label="Copy description" />}>
        <p className="mb-3 text-xs text-gray-500">Read-only. This is the registration material captured earlier; it is NOT wired to any live sending and flipping any value here has no effect while SMS is deferred.</p>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs uppercase text-gray-500">Program</dt><dd>{packet.programName}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Use case</dt><dd>{packet.campaign.useCase}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Legal name</dt><dd>{packet.brand.legalName}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Brand (sender)</dt><dd>{packet.brand.brandName}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Opt-out keywords</dt><dd>{packet.optOutKeywords.join(', ')}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Opt-in / HELP</dt><dd>{packet.optInKeywords.join(', ')} / {packet.helpKeywords.join(', ')}</dd></div>
        </dl>
        <div className="mt-3"><div className="text-xs uppercase text-gray-500">Campaign description</div><p className="mt-1 rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">{packet.campaign.description}</p></div>
        <div className="mt-3"><div className="text-xs uppercase text-gray-500">Sample messages</div>
          <ul className="mt-1 space-y-1 text-xs text-gray-300">{packet.sampleMessages.map((m, i) => <li key={i} className="rounded border border-gray-800 bg-gray-950 p-2">{m}</li>)}</ul>
        </div>
      </Section>
    </MarketingShell>
  )
}

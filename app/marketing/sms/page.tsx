import Link from 'next/link'
import { requireMarketingManager, MarketingShell, Section, StatTile } from '../_components'
import { updateMarketingSettingsAction } from '../actions'
import { getMarketingConfig } from '@/apps/settings/db'
import { getProviders, providerStatus } from '@/apps/marketing/providers'
import { smsLaunchReadiness, type ReadinessStatus } from '@/apps/marketing/readiness'
import { buildA2pPacket } from '@/apps/marketing/a2p'
import { a2pProfile, composeSmsBody } from '@/apps/marketing/compliance'
import { smsSubscriberCount } from '@/apps/marketing/optin'
import { contactAggregates } from '@/apps/marketing/contacts'
import { estimateSegment, NAMED_SEGMENTS } from '@/apps/marketing/segments'
import { Badge } from '@/app/components/ui'
import { CopyButton } from '@/app/components/CopyButton'
import { QrCode, OptInCta } from '@/app/components/OptInCta'
import { count } from '@/app/lib/format'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TONE: Record<ReadinessStatus, 'positive' | 'danger' | 'warn'> = { ready: 'positive', not_ready: 'danger', external: 'warn' }
const STATUS_LABEL: Record<ReadinessStatus, string> = { ready: 'READY', not_ready: 'NOT READY', external: 'NEEDS EXTERNAL ACTION' }

export default async function SmsLaunchPage() {
  await requireMarketingManager('/marketing/sms')
  const cfg = await getMarketingConfig()
  const providerLive = providerStatus(getProviders()).sms
  const webhookBaseConfigured = !!(process.env.TWILIO_WEBHOOK_BASE_URL || cfg.publicBaseUrl)
  const subscriberCount = await smsSubscriberCount()
  const readiness = smsLaunchReadiness({ cfg, providerLive, webhookBaseConfigured, subscriberCount })
  const packet = buildA2pPacket(cfg)
  const p = a2pProfile(cfg)

  // First-campaign preview (sms_subscribers only) — estimate, never a send.
  const aggs = await contactAggregates()
  const est = estimateSegment(aggs, NAMED_SEGMENTS.sms_subscribers.criteria, new Date().getTime())
  const sampleCopy = composeSmsBody('If your paint has picked up swirls or lost gloss, we have paint-correction appointments available. Reply for an estimate.', p)

  return (
    <MarketingShell active="/marketing/sms" title="SMS Launch">
      {/* Go / no-go banner */}
      <div className={`mb-4 rounded-2xl border p-4 ${readiness.canGoLive ? 'border-emerald-700/60 bg-emerald-950/40' : 'border-amber-700/60 bg-amber-950/40'}`}>
        <div className="text-sm font-semibold text-white">{readiness.canGoLive ? 'All software + external checks READY' : `SMS is NOT ready to send — ${readiness.blockers.length} item(s) outstanding`}</div>
        <p className="mt-1 text-xs text-gray-400">Live sending is additionally gated at send time by quiet hours and the dry-run/live flag. Nothing sends until every item below is READY and a manager confirms.</p>
      </div>

      <Section title="SMS launch readiness">
        <ul className="space-y-1.5">
          {readiness.items.map((i) => (
            <li key={i.key} className="flex items-start justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
              <span className="min-w-0"><span className="block text-sm font-medium text-white">{i.label}</span><span className="text-xs text-gray-500">{i.detail}</span></span>
              <Badge tone={TONE[i.status]}>{STATUS_LABEL[i.status]}</Badge>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Business identity, public URLs & A2P confirmations">
        <p className="mb-3 text-xs text-gray-500">URLs must point at the PUBLIC customer-facing domain where /sms-opt-in, /privacy and /terms are published. The approval toggles are confirmed manually AFTER the real external steps — credentials alone never mark SMS ready.</p>
        <form action={updateMarketingSettingsAction} className="space-y-3">
          <input type="hidden" name="__keys" value="marketing_public_base_url,marketing_legal_name,marketing_business_website,marketing_support_contact,marketing_a2p_brand_approved,marketing_a2p_campaign_approved,marketing_advanced_optout_configured,marketing_privacy_published,marketing_terms_published" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Public base URL</label><input name="marketing_public_base_url" defaultValue={cfg.publicBaseUrl} placeholder="https://pittstopdetail.com" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Business website</label><input name="marketing_business_website" defaultValue={cfg.businessWebsite} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Legal / brand name</label><input name="marketing_legal_name" defaultValue={cfg.legalName} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Customer support contact</label><input name="marketing_support_contact" defaultValue={cfg.supportContact} placeholder="text or call (512) …" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              ['marketing_privacy_published', 'Privacy Policy published (with SMS section)', cfg.privacyPublished],
              ['marketing_terms_published', 'SMS Terms published', cfg.termsPublished],
              ['marketing_advanced_optout_configured', 'Twilio Advanced Opt-Out configured', cfg.advancedOptOutConfigured],
              ['marketing_a2p_brand_approved', 'A2P Brand approved', cfg.a2pBrandApproved],
              ['marketing_a2p_campaign_approved', 'A2P Campaign approved', cfg.a2pCampaignApproved],
            ].map(([key, label, val]) => (
              <label key={key as string} className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5">
                <input type="checkbox" name={key as string} defaultChecked={val as boolean} className="h-5 w-5" />
                <span className="text-sm text-white">{label as string}</span>
              </label>
            ))}
          </div>
          <button className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Save</button>
        </form>
      </Section>

      <Section title="Opt-in acquisition tools">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">Public opt-in link</div>
            {p.optInUrl ? (
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-xs text-gray-300">{p.optInUrl}</code><CopyButton value={p.optInUrl} /></div>
            ) : <p className="text-sm text-amber-400">Set the public base URL to generate the opt-in link.</p>}
            <p className="mt-2 text-xs text-gray-500">Staff-entered customers: don&apos;t check a box on their behalf — share this link or show the QR so the customer opts in themselves.</p>
            <div className="mt-3"><OptInCta url={p.optInUrl} /></div>
          </div>
          <div className="flex flex-col items-center">
            <div className="mb-1 self-start text-xs uppercase tracking-wide text-gray-500">QR (counter / printed estimates)</div>
            <QrCode url={p.optInUrl} />
          </div>
        </div>
      </Section>

      <Section title="A2P 10DLC registration packet" right={<CopyButton value={packet.campaign.description} label="Copy description" />}>
        {packet.missing.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-xs text-amber-300">Incomplete — provide: {packet.missing.join('; ')}.</div>
        )}
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs uppercase text-gray-500">Program</dt><dd>{packet.programName}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Use case</dt><dd>{packet.campaign.useCase}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Legal name</dt><dd>{packet.brand.legalName}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Brand (sender)</dt><dd>{packet.brand.brandName}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Opt-out keywords</dt><dd>{packet.optOutKeywords.join(', ')}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Opt-in / HELP</dt><dd>{packet.optInKeywords.join(', ')} / {packet.helpKeywords.join(', ')}</dd></div>
        </dl>
        <div className="mt-3"><div className="text-xs uppercase text-gray-500">Campaign description</div><p className="mt-1 rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">{packet.campaign.description}</p></div>
        <div className="mt-3"><div className="text-xs uppercase text-gray-500">Message flow</div><p className="mt-1 rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">{packet.messageFlow}</p></div>
        <div className="mt-3"><div className="text-xs uppercase text-gray-500">URLs</div>
          <ul className="mt-1 text-xs text-gray-300">
            <li>Website: {packet.urls.website || <span className="text-amber-400">(set)</span>}</li>
            <li>Opt-in: {packet.urls.optIn || <span className="text-amber-400">(set)</span>}</li>
            <li>Privacy: {packet.urls.privacy || <span className="text-amber-400">(set)</span>}</li>
            <li>Terms: {packet.urls.terms || <span className="text-amber-400">(set)</span>}</li>
          </ul>
        </div>
        <div className="mt-3"><div className="text-xs uppercase text-gray-500">Advanced Opt-Out confirmations (configure in Twilio)</div>
          <ul className="mt-1 space-y-1 text-xs text-gray-300">
            <li><span className="text-gray-500">START:</span> {packet.confirmations.optIn}</li>
            <li><span className="text-gray-500">STOP:</span> {packet.confirmations.optOut}</li>
            <li><span className="text-gray-500">HELP:</span> {packet.confirmations.help}</li>
          </ul>
        </div>
        <div className="mt-3"><div className="text-xs uppercase text-gray-500">Sample messages</div>
          <ul className="mt-1 space-y-1 text-xs text-gray-300">{packet.sampleMessages.map((m, i) => <li key={i} className="rounded border border-gray-800 bg-gray-950 p-2">{m}</li>)}</ul>
        </div>
      </Section>

      <Section title="First live campaign — preview (not activated)">
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Audience" value="sms_subscribers" />
          <StatTile label="Eligible (consented)" value={count(est.smsReachable)} />
          <StatTile label="Matched / excluded" value={`${est.total} / ${est.total - est.smsReachable}`} />
          <StatTile label="Provider" value={providerLive && cfg.smsLive ? 'Twilio (LIVE)' : 'Dry-run'} />
        </div>
        <div className="text-xs uppercase text-gray-500">Proposed first message (paint-correction inspection)</div>
        <p className="mt-1 rounded-lg border border-gray-800 bg-gray-950 p-3 text-sm text-gray-200">{sampleCopy}</p>
        <p className="mt-2 text-xs text-gray-500">This is a preview only. To proceed, create the campaign, build recipients, and send — which stays dry-run until every readiness item is READY, within quiet hours, and a manager confirms.</p>
        <div className="mt-3"><Link href="/marketing/campaigns/new" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">Create this campaign →</Link></div>
      </Section>
    </MarketingShell>
  )
}

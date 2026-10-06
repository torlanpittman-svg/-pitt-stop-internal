import { requireMarketingManager, MarketingShell, Section } from '../_components'
import { updateMarketingSettingsAction } from '../actions'
import { getMarketingConfig } from '@/apps/settings/db'
import { getProviders, providerStatus } from '@/apps/marketing/providers'
import { MARKETING_PROFILE } from '@/apps/marketing/profile'
import { money } from '@/app/lib/format'
import { Badge } from '@/app/components/ui'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function ProviderRow({ label, live, note }: { label: string; live: boolean; note: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-white">{label}</div>
        <div className="text-xs text-gray-500">{note}</div>
      </div>
      <Badge tone={live ? 'positive' : 'warn'}>{live ? 'Live' : 'Dry-run'}</Badge>
    </div>
  )
}

export default async function MarketingSettings() {
  await requireMarketingManager('/marketing/settings')
  const cfg = await getMarketingConfig()
  const status = providerStatus(getProviders())

  return (
    <MarketingShell active="/marketing/settings" title="Settings">
      <Section title="Feature + guardrails">
        <form action={updateMarketingSettingsAction} className="space-y-3">
          <label className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5">
            <input type="checkbox" name="marketing_enabled" defaultChecked={cfg.enabled} className="h-5 w-5" />
            <span><span className="block text-sm font-semibold text-white">Marketing enabled</span><span className="text-xs text-gray-500">Shows the home tile + /marketing. Off = ships dark.</span></span>
          </label>
          <label className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5">
            <input type="checkbox" name="marketing_require_approval" defaultChecked={cfg.requireApproval} className="h-5 w-5" />
            <span><span className="block text-sm font-semibold text-white">Require manager approval before send</span><span className="text-xs text-gray-500">Keep on. A campaign must be Ready (approved) before it can send.</span></span>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Send safety cap (recipients / send)</label>
              <input name="marketing_send_daily_cap" defaultValue={cfg.sendDailyCap} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Attribution window (days)</label>
              <input name="marketing_attribution_window_days" defaultValue={cfg.attributionWindowDays} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">High-value threshold ({money(cfg.highValueCents)})</label>
              <input name="marketing_high_value_cents" defaultValue={cfg.highValueCents} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Default approved offer (blank = none)</label>
              <input name="marketing_default_offer" defaultValue={cfg.defaultOffer} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            </div>
          </div>
          <button className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Save settings</button>
        </form>
      </Section>

      <Section title="Provider connections">
        <p className="mb-3 text-xs text-gray-500">Every channel is dry-run until real credentials are set in server env (never in the browser). Marketing never sends externally while dry-run.</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ProviderRow label="SMS" live={status.sms} note="Set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER" />
          <ProviderRow label="Email" live={status.email} note="Set MARKETING_EMAIL_PROVIDER=resend + RESEND_API_KEY (or QB bridge)" />
          <ProviderRow label="Facebook" live={status.facebook} note="Set FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN" />
          <ProviderRow label="Google Ads" live={status.googleAds} note="Set GOOGLE_ADS_DEVELOPER_TOKEN / GOOGLE_ADS_CUSTOMER_ID (read-only)" />
        </div>
      </Section>

      <Section title="Company marketing profile (code-maintained)">
        <p className="mb-3 text-xs text-gray-500">Durable brand knowledge lives in <code className="text-gray-400">apps/marketing/profile.ts</code> so every AI prompt stays consistent. Edit it there.</p>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs uppercase text-gray-500">Business</dt><dd>{MARKETING_PROFILE.companyName}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Service area</dt><dd>{MARKETING_PROFILE.serviceArea}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Hours</dt><dd>{MARKETING_PROFILE.hours}</dd></div>
          <div><dt className="text-xs uppercase text-gray-500">Website</dt><dd>{MARKETING_PROFILE.website}</dd></div>
        </dl>
        <div className="mt-3">
          <div className="text-xs uppercase text-gray-500">Services (promote priority)</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {MARKETING_PROFILE.services.map((s) => <Badge key={s.category} tone="brand">{s.name}</Badge>)}
          </div>
        </div>
        <div className="mt-3">
          <div className="text-xs uppercase text-gray-500">Never claim</div>
          <ul className="mt-1 list-disc pl-5 text-xs text-gray-400">
            {MARKETING_PROFILE.prohibitedClaims.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      </Section>
    </MarketingShell>
  )
}

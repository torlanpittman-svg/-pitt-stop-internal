import { requireMarketingManager, MarketingShell, Section, StatTile } from '../_components'
import { updateMarketingSettingsAction } from '../actions'
import { getMarketingConfig } from '@/apps/settings/db'
import { getProviders, providerStatus } from '@/apps/marketing/providers'
import { MARKETING_PROFILE } from '@/apps/marketing/profile'
import { a2pProfile, smsDisclosureText } from '@/apps/marketing/compliance'
import { smsSubscriberCount } from '@/apps/marketing/optin'
import { money, count } from '@/app/lib/format'
import { Badge } from '@/app/components/ui/Badge'

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
  const a2p = a2pProfile(cfg)
  const subscribers = await smsSubscriberCount()
  const a2pBlockers: string[] = []
  if (!cfg.privacyUrl) a2pBlockers.push('Public Privacy Policy URL (with SMS consent language)')
  if (!cfg.termsUrl) a2pBlockers.push('Public Terms URL (with SMS program terms)')
  if (!status.sms) a2pBlockers.push('Twilio Messaging Service credentials (SMS provider)')

  return (
    <MarketingShell active="/marketing/settings" title="Settings">
      <Section title="Feature + guardrails">
        <form action={updateMarketingSettingsAction} className="space-y-3">
          <input type="hidden" name="__keys" value="marketing_enabled,marketing_require_approval,marketing_send_daily_cap,marketing_attribution_window_days,marketing_high_value_cents,marketing_default_offer" />
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

      <Section title="SMS consent & A2P 10DLC readiness">
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="SMS subscribers (opted in)" value={count(subscribers)} />
          <StatTile label="SMS sending" value={cfg.smsLive ? 'LIVE' : 'Dry-run'} />
          <StatTile label="Quiet hours" value={`${cfg.smsQuietStartHour}:00–${cfg.smsQuietEndHour}:00`} />
          <StatTile label="Per-run cap" value={count(cfg.smsGlobalCap)} />
        </div>
        {a2pBlockers.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-300">
            <div className="font-semibold">Blocking requirements before A2P registration / first live send:</div>
            <ul className="mt-1 list-disc pl-5 text-amber-200/90">{a2pBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
            <p className="mt-2 text-xs text-amber-200/70">Public opt-in page: <code>/sms-opt-in</code>. Privacy/Terms pages exist at <code>/privacy</code> and <code>/terms</code> but must add SMS program language (consent, message frequency, &quot;Msg &amp; data rates may apply&quot;, STOP/HELP, no sharing of opt-in data) before registration.</p>
          </div>
        )}
        <form action={updateMarketingSettingsAction} className="space-y-3">
          <input type="hidden" name="__keys" value="marketing_sms_live,marketing_sms_brand_name,marketing_sms_help_text,marketing_sms_frequency,marketing_privacy_url,marketing_terms_url,marketing_sms_quiet_start_hour,marketing_sms_quiet_end_hour,marketing_sms_global_cap" />
          <label className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5">
            <input type="checkbox" name="marketing_sms_live" defaultChecked={cfg.smsLive} className="h-5 w-5" />
            <span><span className="block text-sm font-semibold text-white">SMS sending LIVE</span><span className="text-xs text-gray-500">Off = dry-run (nothing sends). Requires Twilio creds + a Ready campaign. Never silently flips.</span></span>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">SMS brand name</label><input name="marketing_sms_brand_name" defaultValue={cfg.smsBrandName} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Message frequency text</label><input name="marketing_sms_frequency" defaultValue={cfg.smsFrequency} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">HELP text</label><input name="marketing_sms_help_text" defaultValue={cfg.smsHelpText} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Per-run SMS cap</label><input name="marketing_sms_global_cap" defaultValue={cfg.smsGlobalCap} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Privacy Policy URL</label><input name="marketing_privacy_url" defaultValue={cfg.privacyUrl} placeholder="https://…/privacy" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Terms URL</label><input name="marketing_terms_url" defaultValue={cfg.termsUrl} placeholder="https://…/terms" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Quiet start hour (0–23)</label><input name="marketing_sms_quiet_start_hour" defaultValue={cfg.smsQuietStartHour} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
            <div><label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Quiet end hour (0–23)</label><input name="marketing_sms_quiet_end_hour" defaultValue={cfg.smsQuietEndHour} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /></div>
          </div>
          <button className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Save SMS/A2P settings</button>
        </form>
        <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950 p-3">
          <div className="text-xs uppercase tracking-wide text-gray-500">Opt-in disclosure (shown to customers, stored with each consent)</div>
          <p className="mt-1 text-xs text-gray-300">{smsDisclosureText(a2p)}</p>
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

/**
 * Public SMS opt-in page — the verifiable A2P 10DLC opt-in URL. No auth (customer-facing), and
 * intentionally NOT in the proxy matcher. Consent is affirmative (unchecked box), stored with the
 * exact disclosure wording + version + request metadata via recordPublicOptIn.
 */
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getMarketingConfig } from '@/apps/settings/db'
import { a2pProfile, smsDisclosureText, SMS_OPT_IN_VERSION } from '@/apps/marketing/compliance'
import { recordPublicOptIn, ConsentNotGivenError, InvalidPhoneError } from '@/apps/marketing/optin'
import { SmsConsentDisclosure } from '@/app/components/SmsConsentDisclosure'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function submitOptIn(formData: FormData): Promise<void> {
  'use server'
  const cfg = await getMarketingConfig()
  const p = a2pProfile(cfg)
  const h = await headers()
  try {
    await recordPublicOptIn({
      agreed: formData.get('smsConsent') === 'on',
      phone: String(formData.get('phone') ?? ''),
      name: String(formData.get('name') ?? ''),
      consentText: smsDisclosureText(p),
      wordingVersion: SMS_OPT_IN_VERSION,
      source: 'website_form',
      ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: h.get('user-agent') ?? null,
    })
  } catch (e) {
    const code = e instanceof ConsentNotGivenError ? 'consent' : e instanceof InvalidPhoneError ? 'phone' : 'error'
    redirect(`/sms-opt-in?error=${code}`)
  }
  redirect('/sms-opt-in?done=1')
}

export default async function SmsOptInPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const { done, error } = await searchParams
  const cfg = await getMarketingConfig()
  const p = a2pProfile(cfg)
  const disclosure = smsDisclosureText(p)

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-950 px-4 py-10 text-white">
      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6">
        <h1 className="text-lg font-bold">{p.brandName} — Text updates</h1>
        {done ? (
          <p className="mt-3 text-sm text-emerald-400">
            You&apos;re subscribed. We&apos;ll only text occasional detailing offers and reminders. Reply STOP anytime to opt out, HELP for help.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-gray-400">Get occasional detailing offers and reminders by text. Optional — never required to book or buy.</p>
            {error === 'consent' && <p className="mt-2 text-sm text-amber-400">Please check the box to agree before subscribing.</p>}
            {error === 'phone' && <p className="mt-2 text-sm text-amber-400">Please enter a valid 10-digit US mobile number.</p>}
            {error === 'error' && <p className="mt-2 text-sm text-red-400">Something went wrong. Please try again.</p>}
            <form action={submitOptIn} className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Name (optional)</label>
                <input name="name" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Mobile number</label>
                <input name="phone" inputMode="tel" required placeholder="(512) 555-0123" className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
              </div>
              <SmsConsentDisclosure disclosure={disclosure} privacyUrl={p.privacyUrl || undefined} termsUrl={p.termsUrl || undefined} />
              <button className="w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">Subscribe to texts</button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}

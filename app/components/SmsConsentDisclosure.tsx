/**
 * Reusable SMS opt-in disclosure + checkbox. Drop into ANY form (estimate, booking, intake, website
 * lead) to capture A2P-compliant promotional-SMS consent. Rules baked in:
 *   • the checkbox is NEVER pre-checked (consent must be affirmative),
 *   • consent is NOT a condition of purchase and is NOT bundled with other terms (it is its own field),
 *   • the exact disclosure wording is shown and should be stored with the consent event (audit).
 *
 * Server-component-safe (plain markup). The containing form posts `name` (default "smsConsent") = "on".
 */
import type { ReactNode } from 'react'

const DEFAULT_LABEL =
  "Yes, I'd like to receive recurring promotional text messages from Pitt Stop Detail & Auto Sales about " +
  'services, appointment opportunities and offers. Up to 3 marketing messages per month. Message and data ' +
  'rates may apply. Reply STOP to unsubscribe or HELP for help. Consent is not a condition of purchase.'

export function SmsConsentDisclosure({
  name = 'smsConsent',
  disclosure = DEFAULT_LABEL,
  privacyUrl,
  termsUrl,
  children,
}: {
  name?: string
  disclosure?: string
  privacyUrl?: string
  termsUrl?: string
  children?: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-700 bg-gray-950 p-3">
      {/* Not pre-checked: no defaultChecked / checked. */}
      <input type="checkbox" name={name} value="on" className="mt-0.5 h-5 w-5 shrink-0" />
      <span className="text-xs leading-relaxed text-gray-300">
        {children ?? disclosure}
        {(privacyUrl || termsUrl) && (
          <span className="mt-1 block text-gray-500">
            {privacyUrl && <a href={privacyUrl} className="underline hover:text-gray-300">Privacy Policy</a>}
            {privacyUrl && termsUrl && ' · '}
            {termsUrl && <a href={termsUrl} className="underline hover:text-gray-300">Terms</a>}
          </span>
        )}
      </span>
    </label>
  )
}

/**
 * Reusable, A2P-compliant SMS program disclosures for the PUBLIC Privacy Policy and Terms. Kept in one
 * component so the wording stays consistent and can be republished on the customer-facing business
 * website verbatim. All names/URLs are config-driven (from the marketing A2P profile) — nothing is
 * hard-coded to a fake domain. These sections describe ONLY the opt-in promotional-SMS program.
 */
import type { A2pProfile } from '@/apps/marketing/compliance'

function Support({ contact }: { contact: string }) {
  return <>{contact ? <>{contact}</> : <span className="italic text-gray-500">(see the contact information above)</span>}</>
}

/** SMS section for the Privacy Policy. */
export function SmsPrivacySection({ profile }: { profile: A2pProfile }) {
  return (
    <section id="sms" className="mt-8">
      <h2 className="text-lg font-semibold text-white mb-2">SMS / Text Messaging</h2>
      <p className="mb-3 text-gray-300">
        This section applies to {profile.legalName}&apos;s promotional text-message program for customers who
        choose to receive texts. It supplements (and does not override) the rest of this policy.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-gray-300">
        <li><strong>What we collect:</strong> your mobile phone number and a record of your opt-in (the date and time, the exact consent language shown, and where you opted in).</li>
        <li><strong>How we use it:</strong> only to send you {profile.legalName} promotional and service text messages after you affirmatively opt in. We do not text you promotional messages without your consent.</li>
        <li><strong>Message frequency:</strong> {profile.messageFrequency}</li>
        <li><strong>Rates:</strong> Message and data rates may apply.</li>
        <li><strong>Opting out:</strong> reply STOP to any message to stop, or HELP for help. You can also use the unsubscribe link we provide.</li>
        <li>
          <strong>No sharing of opt-in data:</strong> We do not sell or share your SMS opt-in information or
          your consent with third parties or affiliates for their own marketing or promotional purposes.
          Your mobile information is shared only with the messaging provider(s) (for example, Twilio)
          strictly necessary to deliver these messages.
        </li>
      </ul>
    </section>
  )
}

/** SMS Program section for the Terms. */
export function SmsTermsSection({ profile }: { profile: A2pProfile }) {
  return (
    <section id="sms" className="mt-8">
      <h2 className="text-lg font-semibold text-white mb-2">SMS / Text Messaging Program</h2>
      <p className="mb-2 text-gray-300"><strong>Program:</strong> Pitt Stop Detail &amp; Auto Sales SMS Marketing.</p>
      <p className="mb-3 text-gray-300">
        <strong>Purpose:</strong> Customers who affirmatively opt in may receive recurring text messages from
        {' '}{profile.legalName} about detailing services, ceramic coating, paint correction, interior
        detailing/restoration, appointment opportunities, promotions and offers, and other Pitt Stop
        service information. (Replies you send to us are handled as normal conversations and are not part of
        the recurring promotional program.)
      </p>
      <ul className="list-disc space-y-1 pl-5 text-gray-300">
        <li><strong>Message frequency:</strong> {profile.messageFrequency} Frequency may vary within this limit.</li>
        <li>Message and data rates may apply.</li>
        <li>Consent is not a condition of any purchase.</li>
        <li>Reply <strong>STOP</strong> to opt out at any time. Reply <strong>HELP</strong> for help.</li>
        <li><strong>Support:</strong> <Support contact={profile.supportContact} /></li>
        <li>Carriers are not liable for delayed or undelivered messages.</li>
        <li>See our {profile.privacyUrl ? <a className="underline" href={profile.privacyUrl}>Privacy Policy</a> : <a className="underline" href="/privacy">Privacy Policy</a>} for how we handle your information.</li>
      </ul>
    </section>
  )
}

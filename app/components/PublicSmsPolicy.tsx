import type { A2pProfile } from '@/apps/marketing/compliance'
import { SmsPrivacySection, SmsTermsSection } from './SmsProgramDisclosures'

export function PublicSmsPolicy({ profile, kind }: { profile: A2pProfile; kind: 'privacy' | 'terms' }) {
  return <main className="min-h-screen bg-gray-950 px-6 py-12 text-gray-200">
    <div className="mx-auto max-w-2xl">
      <p className="mb-3 text-sm font-semibold text-blue-300">{profile.legalName}</p>
      <h1 className="mb-2 text-3xl font-bold text-white">{kind === 'privacy' ? 'SMS Privacy Policy' : 'SMS Program Terms'}</h1>
      <p className="mb-6 text-sm text-gray-400">Last updated: October 6, 2026</p>
      <p>These {kind === 'privacy' ? 'privacy disclosures' : 'terms'} cover the optional promotional text program of Pitt Stop Detail &amp; Auto Sales, 3112 Texas Ave S, College Station, TX 77845.</p>
      {kind === 'privacy' ? <>
        <SmsPrivacySection profile={profile} />
        <h2 className="mb-2 mt-8 text-lg font-semibold text-white">Consent records and security</h2>
        <p>We retain your number, consent history, and message records to operate the program, honor opt-outs, and document your choices. Our signup form also records the request&apos;s IP address and browser information. Access is restricted to authorized staff and the service providers needed to operate the program.</p>
      </> : <SmsTermsSection profile={profile} />}
      <h2 className="mb-2 mt-8 text-lg font-semibold text-white">Contact us</h2>
      <p>{profile.supportContact}</p>
      <nav className="mt-8 flex flex-wrap gap-4 text-sm text-blue-300">
        <a className="underline" href={profile.website}>Pitt Stop website</a>
        <a className="underline" href="/sms-opt-in">Text signup</a>
        <a className="underline" href={kind === 'privacy' ? '/terms' : '/privacy'}>{kind === 'privacy' ? 'SMS terms' : 'SMS privacy'}</a>
      </nav>
    </div>
  </main>
}

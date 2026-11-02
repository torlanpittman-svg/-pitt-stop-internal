/**
 * Appointments → Notifications. Turn booking alerts on for THIS phone, plus the iPhone Home Screen
 * install steps (iOS will not deliver Web Push to a Safari tab, only to the installed app).
 *
 * Manager/admin only, re-checked here as well as in proxy.ts and in every /api/appointments/push
 * handler. Nothing on this page reveals customer information.
 */
import Link from 'next/link'
import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { authorizedManagerStrict } from '@/apps/auth/employee-guard'
import { listSubscriptions, mayEnrol, recentDeliveryProblems } from '@/apps/staff-alerts/db'
import { pushConfig } from '@/apps/staff-alerts/web-push'
import EnableNotifications from './EnableNotifications'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const IPHONE_STEPS = [
  'Open Safari on the iPhone and go to the Pitt Stop OS address you normally use.',
  'Sign in with your PIN, so the installed app starts out signed in.',
  'Tap the Share button (the square with the arrow pointing up) at the bottom of Safari.',
  'Scroll down and tap "Add to Home Screen", then tap "Add".',
  'Close Safari and open Pitt Stop OS from the new Home Screen icon.',
  'In the installed app go to Appointments → Notifications and tap "Enable notifications on this device".',
  'Tap "Allow" when iPhone asks about notifications, then tap "Send a test notification" to confirm it arrives.',
]

export default async function NotificationsPage() {
  const actor = await authorizedManagerStrict()
  if (!mayEnrol(actor)) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title="Notifications" />
        <PageContainer className="py-6">
          <p className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-sm text-gray-300">
            Booking notifications are for managers and admins. Ask a manager to set this up.
          </p>
        </PageContainer>
      </div>
    )
  }

  const configured = !!pushConfig()
  const [everyone, problems] = await Promise.all([listSubscriptions(), recentDeliveryProblems(actor.key)])

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments', label: 'Appointments' }} title="Notifications" />
      <PageContainer className="py-6">
        <PageHeader
          kicker="Appointments"
          title="Booking notifications"
          actions={<Link href="/appointments?view=today" className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-200">New bookings</Link>}
        />

        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-gray-400">
          When a customer finishes booking online, every enrolled phone gets a notification — even
          when Pitt Stop is closed in the background. The notification shows only the drop-off time;
          the customer&rsquo;s details stay behind your PIN, on the appointment screen the notification opens.
        </p>

        {problems.length > 0 && (
          <section className="mt-5 rounded-xl border border-red-900 bg-red-950/30 p-4">
            <h2 className="text-sm font-semibold text-red-100">
              {problems.length === 1 ? 'An alert could not be delivered' : `${problems.length} alerts could not be delivered`} to your devices
            </h2>
            <p className="mt-1 text-sm text-red-100/90">
              Turn notifications off and on again on the affected phone. If it keeps failing, the
              server&rsquo;s notification keys may have been changed — every device has to be enabled again.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-red-200/80">
              {problems.map((p, i) => (
                <li key={`${p.at.toISOString()}-${i}`} className="break-words">
                  {p.deviceLabel ?? 'Device'} · {p.at.toLocaleString()}{p.error ? ` — ${p.error}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-6">
          <EnableNotifications />
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Setting up an iPhone</h2>
          <p className="mt-2 max-w-2xl text-sm text-gray-400">
            iPhone and iPad only deliver notifications to an app that has been added to the Home
            Screen — a Safari tab cannot receive them. Do this once per phone (iOS 16.4 or newer).
          </p>
          <ol className="mt-3 max-w-2xl list-decimal space-y-2 pl-5 text-sm text-gray-300">
            {IPHONE_STEPS.map((step) => <li key={step} className="break-words leading-relaxed">{step}</li>)}
          </ol>
          <p className="mt-3 max-w-2xl text-xs text-gray-500">
            Android, Chrome, Edge and Firefox do not need the install step — just tap Enable. Each
            device is separate, and turning a device off here (or signing out on it) stops its alerts.
          </p>
        </section>

        {!configured && (
          <section className="mt-8 rounded-xl border border-amber-800 bg-amber-950/30 p-4">
            <h2 className="text-sm font-semibold text-amber-100">Server setup still needed</h2>
            <p className="mt-1 text-sm text-amber-100/90">
              Notification keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT) are not set in this
              environment, so no device can be enrolled yet. They are generated once with
              <code className="mx-1 rounded bg-black/30 px-1">npx tsx scripts/generate-vapid-keys.ts</code>
              and saved as environment variables. No external account or subscription is involved.
            </p>
          </section>
        )}

        {everyone.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">All enrolled devices</h2>
            <p className="mt-1 text-xs text-gray-500">So a manager can see who is actually covered. Names and device types only — no addresses or keys.</p>
            <ul className="mt-2 space-y-1 text-sm text-gray-400">
              {everyone.map((d) => (
                <li key={d.id} className="break-words">{d.employeeName} — {d.deviceLabel ?? 'Device'}</li>
              ))}
            </ul>
          </section>
        )}
      </PageContainer>
    </div>
  )
}

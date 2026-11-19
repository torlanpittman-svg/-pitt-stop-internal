/**
 * Staff PREVIEW of the three recovery emails for one cancellation — rendered by the same function the dispatcher
 * uses, with this customer's real name, vehicle, services and links. It sends nothing and queues nothing.
 * Managers/admins only, fail-closed.
 */
import { notFound, redirect } from 'next/navigation'
import NavHeader from '@/app/components/NavHeader'
import { PageContainer, PageHeader } from '@/app/components/ui/PageHeader'
import { authorizedManagerStrict } from '@/apps/auth/employee-guard'
import { getAppointment, getBookingConfig } from '@/apps/appointments/db'
import { buildRecoveryEmail, getRecovery, recoverySchedule, type RecoveryStep } from '@/apps/appointments/recovery'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const when = (d: Date) => d.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default async function RecoveryPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await authorizedManagerStrict())) redirect('/appointments')
  const { id } = await params
  const rec = await getRecovery(id)
  if (!rec) notFound()
  const [appt, cfg] = await Promise.all([getAppointment(rec.appointmentId), getBookingConfig()])
  if (!appt) notFound()
  const steps: RecoveryStep[] = [1, 2, 3]
  const emails = await Promise.all(steps.map((s) => buildRecoveryEmail(s, appt, rec.id, cfg)))
  // Timing if the sequence ran from the cancellation; a manager-started sequence counts from the moment it starts.
  const times = recoverySchedule(rec.sequenceStartedAt ?? rec.cancelledAt, cfg)

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/appointments/recovery', label: 'Lead Recovery' }} title="Email preview" />
      <PageContainer className="py-6">
        <PageHeader kicker="Lead Recovery" title={`Recovery emails — ${appt.firstName} ${appt.lastName}`.trim()}
          subtitle={`Preview only. Nothing on this page sends an email. Would go to ${appt.email ?? 'no email address on file'}.`} />
        <div className="mt-6 space-y-8">
          {emails.map((e, i) => (
            <section key={i} className="rounded-xl border border-gray-800 bg-gray-900 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Email {i + 1} · {cfg.recoveryDelayHours[i]} h after {rec.sequenceStartedAt ? 'follow-ups started' : 'the cancellation'} ({when(times[i])})</h2>
              <p className="mt-2 text-base"><span className="text-gray-500">Subject:</span> <span className="font-semibold">{e.subject}</span></p>
              <iframe title={`Email ${i + 1} preview`} srcDoc={e.html} sandbox="" className="mt-3 h-[560px] w-full rounded-lg border border-gray-800 bg-white" />
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-gray-400">Plain-text version</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-gray-950 p-3 text-sm text-gray-200">{e.text}</pre>
              </details>
            </section>
          ))}
        </div>
      </PageContainer>
    </div>
  )
}

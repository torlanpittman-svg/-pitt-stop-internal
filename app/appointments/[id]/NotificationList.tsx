'use client'

/**
 * Customer email delivery status for one appointment — so staff can tell, without guessing, whether a
 * confirmation actually went out. Reads the durable outbox (appointment_notifications); it never sends
 * anything itself. "Send again" re-queues a notice that is provably un-sent (failed / no provider) and is
 * manager-only; a notice that MAY have been delivered ('uncertain') is deliberately not offered, so staff
 * can never turn an uncertain delivery into a duplicate email.
 */
import { useState, useTransition } from 'react'
import { Badge, type BadgeTone } from '@/app/components/ui/Badge'
import { dispatchNowAction, requeueAction } from '../actions'

export interface NoticeView {
  id: string
  kind: string
  status: string
  error: string | null
  /** True only for a test-mode hold. Decided on the server — never inferred from status+error here. */
  held: boolean
  /** True when this skip means the customer was never told. Also decided on the server. */
  missed: boolean
  providerMessageId: string | null
  sentAt: string | null
  sendAfter: string
}

const KIND: Record<string, string> = {
  confirmation: 'Confirmation', reminder: 'Reminder', reschedule: 'Reschedule', cancellation: 'Cancellation',
}

function describe(n: NoticeView): { label: string; tone: BadgeTone; detail: string } {
  switch (n.status) {
    case 'sent':
      return { label: 'Sent', tone: 'positive', detail: n.providerMessageId ? `Provider ID ${n.providerMessageId}` : '' }
    case 'sending':
      return { label: 'Sending…', tone: 'info', detail: '' }
    case 'pending':
      if (n.held) return { label: 'Held (test mode)', tone: 'warn', detail: `${n.error} It is still queued and will go out once testing restrictions are removed.` }
      // Also 'pending': a temporary delivery failure waiting on its retry. That is a real problem and must
      // not read as a harmless test artefact.
      if (n.error) return { label: 'Retrying', tone: 'danger', detail: `Delivery failed and will be retried: ${n.error}` }
      return { label: 'Queued', tone: 'info', detail: '' }
    case 'not_configured':
      return { label: 'Not sent', tone: 'warn', detail: 'No email provider is set up, so nothing was sent.' }
    case 'failed':
      return { label: 'Failed', tone: 'danger', detail: n.error ?? 'Not delivered.' }
    case 'uncertain':
      return { label: 'May have been delivered', tone: 'warn', detail: n.error ?? 'Not resent automatically, to avoid a duplicate.' }
    case 'skipped':
      // 'skipped' covers both deliberate housekeeping (a reminder for a cancelled booking) and a genuine
      // miss (a notice that outlived the moment it was true). Those must not look the same.
      return n.missed
        ? { label: 'Not sent', tone: 'danger', detail: `This customer was never told (${n.error}). Contact them directly — it is too late for this email to be accurate.` }
        : { label: 'Not needed', tone: 'neutral', detail: n.error ?? '' }
    default:
      return { label: n.status, tone: 'neutral', detail: n.error ?? '' }
  }
}

export default function NotificationList({ appointmentId, notices, isManager }: {
  appointmentId: string; notices: NoticeView[]; isManager: boolean
}) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  if (notices.length === 0) {
    return <p className="mt-2 text-sm text-gray-400">No customer email was queued for this appointment (no email address on file, or confirmations were off when it was booked).</p>
  }

  return (
    <>
      <ul className="mt-2 divide-y divide-gray-800 rounded-xl border border-gray-800 bg-gray-900 text-sm">
        {notices.map((n) => {
          const d = describe(n)
          // Matches requeueNotification's SQL exactly: only provably un-sent notices can be re-queued.
          const canRetry = isManager && (n.status === 'failed' || n.status === 'not_configured')
          // A held notice needs no re-queue — it is already pending and due. It needs a dispatcher.
          const canRelease = isManager && n.held
          return (
            <li key={n.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-gray-200">{KIND[n.kind] ?? n.kind}</span>
                <Badge tone={d.tone}>{d.label}</Badge>
                {canRelease && (
                  <button type="button" disabled={pending}
                    onClick={() => start(async () => {
                      setMsg(null)
                      const r = await dispatchNowAction(appointmentId)
                      setMsg(r.ok ? 'Attempted now — refresh to see the result.' : r.error)
                    })}
                    className="ml-auto min-h-9 rounded-lg border border-amber-800 px-3 text-xs text-amber-200 disabled:opacity-60">
                    {pending ? 'Working…' : 'Try now'}
                  </button>
                )}
                {canRetry && (
                  <button type="button" disabled={pending}
                    onClick={() => start(async () => {
                      setMsg(null)
                      const r = await requeueAction(n.id, appointmentId)
                      setMsg(r.ok ? 'Queued — the next run will re-check it and send if it is still valid.' : r.error)
                    })}
                    className="ml-auto min-h-9 rounded-lg border border-emerald-800 px-3 text-xs text-emerald-200 disabled:opacity-60">
                    {pending ? 'Working…' : 'Send again'}
                  </button>
                )}
              </div>
              {d.detail && <p className="mt-1 break-words text-xs text-gray-400">{d.detail}</p>}
            </li>
          )
        })}
      </ul>
      {msg && <p className="mt-2 text-xs text-gray-300">{msg}</p>}
    </>
  )
}

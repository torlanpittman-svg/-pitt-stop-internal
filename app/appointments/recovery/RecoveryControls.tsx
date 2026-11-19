'use client'

/** Lead Recovery row actions. Every button is one audited server action; each re-checks manager role server-side. */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  recoveryEnrollAction, recoveryStartAction, recoveryPauseAction, recoveryResumeAction, recoveryStopAction, recoveryOutcomeAction,
  recoveryMatchAction, recoverySendNowAction, recoveryConsentAction, type ActionResult,
} from '../actions'

const btn = 'min-h-9 rounded-lg border border-gray-700 px-3 text-sm text-gray-200 hover:border-gray-500 disabled:cursor-default disabled:opacity-50'
const primary = 'min-h-9 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-gray-950 disabled:opacity-50'

function useAction() {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = (fn: () => Promise<ActionResult>, done: string) => start(async () => {
    const r = await fn()
    setMsg(r.ok ? { ok: true, text: done } : { ok: false, text: r.error })
  })
  return { pending, msg, run }
}

export function RecoveryControls({ id, status, outcome, emailsOn, canEmail, hasUnsent, matchPending, needsConsent }: {
  id: string; status: string; outcome: string | null; emailsOn: boolean; canEmail: boolean; hasUnsent: boolean; matchPending: boolean
  /** Emailable in every other respect, but no email-marketing permission is on record. */
  needsConsent: boolean
}) {
  const { pending, msg, run } = useAction()
  const open = status === 'review' || status === 'active' || status === 'paused' || status === 'finished'
  const mayEmail = emailsOn && canEmail
  return (
    <div className="mt-3 border-t border-gray-800 pt-3">
      <div className="flex flex-wrap gap-2">
        {/* A lead that can never be emailed (Pitt Stop cancelled, or no address) gets no email buttons at all. */}
        {status === 'review' && canEmail && (
          <button type="button" className={primary} disabled={pending || !mayEmail} onClick={() => run(() => recoveryStartAction(id), 'Follow-ups started.')}>Start follow-ups</button>
        )}
        {canEmail && (status === 'review' || (status === 'active' && hasUnsent)) && (
          <button type="button" className={btn} disabled={pending || !mayEmail} onClick={() => run(() => recoverySendNowAction(id), 'Sending the next email now.')}>Send next email now</button>
        )}
        {needsConsent && (status === 'review' || status === 'paused') && (
          <button type="button" className={btn} disabled={pending}
            onClick={() => { if (window.confirm('Record that this customer told you they agree to follow-up email from Pitt Stop? This is saved under your name.')) run(() => recoveryConsentAction(id), 'Permission recorded.') }}>
            Customer agreed to email
          </button>
        )}
        {status === 'active' && <button type="button" className={btn} disabled={pending} onClick={() => run(() => recoveryPauseAction(id), 'Follow-ups paused.')}>Pause</button>}
        {status === 'paused' && <button type="button" className={btn} disabled={pending || !mayEmail} onClick={() => run(() => recoveryResumeAction(id), 'Follow-ups resumed.')}>Resume</button>}
        {(status === 'active' || status === 'paused') && <button type="button" className={btn} disabled={pending} onClick={() => run(() => recoveryStopAction(id), 'Follow-ups stopped.')}>Stop follow-ups</button>}
        {status !== 'rebooked' && (
          <>
            <button type="button" className={btn} disabled={pending || outcome === 'contacted'} aria-pressed={outcome === 'contacted'} onClick={() => run(() => recoveryOutcomeAction(id, 'contacted'), 'Marked contacted.')}>Contacted</button>
            <button type="button" className={btn} disabled={pending || outcome === 'not_interested'} aria-pressed={outcome === 'not_interested'} onClick={() => run(() => recoveryOutcomeAction(id, 'not_interested'), 'Marked not interested — follow-ups stopped.')}>Not interested</button>
            <button type="button" className={btn} disabled={pending || outcome === 'recovered'} aria-pressed={outcome === 'recovered'} onClick={() => run(() => recoveryOutcomeAction(id, 'recovered'), 'Marked recovered — follow-ups stopped.')}>Recovered</button>
          </>
        )}
        {matchPending && (
          <>
            <button type="button" className={primary} disabled={pending} onClick={() => run(() => recoveryMatchAction(id, 'confirmed'), 'Counted as a recovery.')}>Yes, this is the recovery</button>
            <button type="button" className={btn} disabled={pending} onClick={() => run(() => recoveryMatchAction(id, 'rejected'), 'Marked unrelated.')}>Unrelated booking</button>
          </>
        )}
      </div>
      {open && !mayEmail && (
        <p className="mt-2 text-xs text-gray-500">{needsConsent ? 'No email permission on record — follow up by phone, or record the customer’s permission.' : !canEmail ? 'Recovery emails are never sent for this lead — follow up by phone.' : 'Recovery emails are off in Booking settings, so nothing can be sent from here.'}</p>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mt-2 text-xs ${msg.ok ? 'text-emerald-300' : 'text-amber-300'}`}>{msg.text}</p>}
    </div>
  )
}

export function EnrollButton({ appointmentId }: { appointmentId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className={btn} disabled={pending} onClick={() => start(async () => {
        const r = await recoveryEnrollAction(appointmentId)
        // The row leaves this list once it is queued, so take the manager to where it now is.
        if (r.ok) router.push('/appointments/recovery?view=attention')
        else setError(r.error)
      })}>{pending ? 'Adding…' : 'Add to queue'}</button>
      {error && <span role="alert" className="text-xs text-amber-300">{error}</span>}
    </span>
  )
}

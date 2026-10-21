'use client'

import { useActionState } from 'react'
import { saveSettingsAction } from '../actions'
import { WEEKDAYS, type BookingConfig } from '@/apps/appointments/policy'

const box = 'mt-1 h-11 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-white'
const DAY: Record<string, string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' }

function Check({ name, label, on }: { name: string; label: string; on: boolean }) {
  return <label className="flex items-center gap-2 text-sm text-gray-200"><input type="checkbox" name={name} defaultChecked={on} className="h-4 w-4" />{label}</label>
}
function Num({ name, label, value, hint }: { name: string; label: string; value: number | null; hint?: string }) {
  return (
    <label className="block text-sm text-gray-300">{label}
      <input type="number" min={0} name={name} defaultValue={value ?? ''} className={box} />
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  )
}

export default function SettingsForm({ cfg }: { cfg: BookingConfig }) {
  const [state, action, pending] = useActionState(saveSettingsAction, null)
  return (
    <form action={action} className="mt-6 space-y-8">
      <section className="space-y-3">
        <h2 className="font-semibold">Online booking</h2>
        <Check name="enabled" label="Online booking is ON (customers can book on the public page)" on={cfg.enabled} />
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-gray-300">Time spacing
            <select name="intervalMinutes" defaultValue={cfg.intervalMinutes} className={box}>
              {[10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>Every {m} min</option>)}
            </select>
          </label>
          <Num name="maxAdvanceDays" label="Book up to (days ahead)" value={cfg.maxAdvanceDays} />
        </div>
        <Check name="sameDayEnabled" label="Allow same-day booking" on={cfg.sameDayEnabled} />
        <Num name="sameDayLeadMinutes" label="Minimum notice (minutes before drop-off)" value={cfg.sameDayLeadMinutes} hint="Example: 60 means at 8:10 AM the first open time is 9:15 AM." />
        <Check name="federalHolidaysClosed" label="Closed on federal holidays (actual date, no Friday/Monday substitutes)" on={cfg.federalHolidaysClosed} />
      </section>

      <section>
        <h2 className="font-semibold">Drop-off window</h2>
        <p className="mt-1 text-xs text-gray-500">The latest time is the online cutoff (default 11:00 AM). Managers can still book later times with override.</p>
        <div className="mt-3 space-y-2">
          {WEEKDAYS.map((w) => (
            <div key={w} className="grid grid-cols-[4.5rem_1fr_1fr] items-center gap-2">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`day_${w}_open`} defaultChecked={cfg.days[w].open} className="h-4 w-4" />{DAY[w]}</label>
              <input type="time" name={`day_${w}_start`} defaultValue={cfg.days[w].start} step={300} className="h-10 rounded-lg border border-gray-700 bg-gray-950 px-2 text-white" aria-label={`${DAY[w]} first time`} />
              <input type="time" name={`day_${w}_cutoff`} defaultValue={cfg.days[w].cutoff} step={300} className="h-10 rounded-lg border border-gray-700 bg-gray-950 px-2 text-white" aria-label={`${DAY[w]} latest time`} />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Capacity</h2>
        <p className="text-xs text-gray-500">The appointment time is the drop-off time only. These numbers space customer arrivals apart; they do not schedule technicians or bays.</p>
        <div className="grid grid-cols-2 gap-3">
          <Num name="slotCapacity" label="Public drop-offs per time" value={cfg.slotCapacity} hint="1 = one customer per time." />
          <Num name="dailyAppointmentLimit" label="Daily appointment limit" value={cfg.dailyAppointmentLimit} hint="Blank = unlimited." />
        </div>
        <Check name="workloadLimitsEnabled" label="Limit daily workload (uses the service weights below)" on={cfg.workloadLimitsEnabled} />
        <p className="text-xs text-gray-500">Off = weights are stored but never close a time or a day.</p>
        <div className="grid grid-cols-2 gap-3">
          <Num name="dailyUnits" label="Daily workload units" value={cfg.dailyUnits} hint="Only used when workload limits are on." />
          <Num name="limitDetail" label="Daily detailing units (optional)" value={cfg.categoryLimits.detail} />
          <Num name="limitMechanic" label="Daily mechanic units (optional)" value={cfg.categoryLimits.mechanic} />
        </div>
        <p className="text-xs text-gray-500">Customer-facing name and description appear on the booking cards. Tick a service to offer it online.</p>
        <div className="divide-y divide-gray-800 rounded-xl border border-gray-800">
          {cfg.services.map((s) => (
            <div key={s.key} className="grid gap-2 px-3 py-3">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`svc_${s.key}_enabled`} defaultChecked={s.enabled} className="h-4 w-4" aria-label={`Offer ${s.label} online`} />
                  <span className="text-xs text-gray-500">{s.key} · {s.category}</span></label>
                <label className="ml-auto text-xs text-gray-400">weight
                  <input type="number" min={0} max={20} name={`svc_${s.key}_weight`} defaultValue={s.weight} className="ml-2 h-9 w-16 rounded-lg border border-gray-700 bg-gray-950 px-2 text-white" /></label>
              </div>
              <input name={`svc_${s.key}_label`} defaultValue={s.label} maxLength={80} aria-label={`${s.key} name`} className="h-10 rounded-lg border border-gray-700 bg-gray-950 px-3 text-sm text-white" />
              <input name={`svc_${s.key}_description`} defaultValue={s.description} maxLength={240} aria-label={`${s.key} description`} className="h-10 rounded-lg border border-gray-700 bg-gray-950 px-3 text-sm text-gray-300" />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Customer messages</h2>
        <Check name="confirmationEnabled" label="Email a confirmation (when an email provider is set up)" on={cfg.confirmationEnabled} />
        <Check name="reminderEnabled" label="Email a reminder" on={cfg.reminderEnabled} />
        <div className="grid grid-cols-2 gap-3">
          <Num name="reminderHoursBefore" label="Reminder (hours before)" value={cfg.reminderHoursBefore} />
          <Num name="cancelCutoffMinutes" label="Online cancel until (minutes before)" value={cfg.cancelCutoffMinutes} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Unfinished bookings</h2>
        <p className="text-xs text-gray-500">Customers who enter their details but don&apos;t confirm appear under Appointments → Unfinished bookings. One follow-up email goes only to customers who ticked &ldquo;If I don&apos;t finish booking, Pitt Stop may email me…&rdquo;, and never after they book. Owner-approved: one email 24 hours after the customer&apos;s last activity (sent within about an hour after that, never earlier); erase contact details after 90 days. Closing a lead stops its email. No email is sent until an email provider is set up.</p>
        <Check name="draftFollowUpEnabled" label="Send the one follow-up email (needs an email provider)" on={cfg.draftFollowUpEnabled} />
        <Check name="draftRetentionEnabled" label="Erase unfinished-booking contact details after the retention period" on={cfg.draftRetentionEnabled} />
        <div className="grid grid-cols-2 gap-3">
          <Num name="draftFollowUpDelayHours" label="Follow-up delay (hours)" value={cfg.draftFollowUpDelayHours} hint="After the customer's last activity." />
          <Num name="draftRetentionDays" label="Retention (days)" value={cfg.draftRetentionDays} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Public page text</h2>
        {([['title', 'Title', cfg.title], ['intro', 'Intro', cfg.intro], ['phone', 'Phone', cfg.phone], ['address', 'Address', cfg.address]] as const).map(([n, l, v]) => (
          <label key={n} className="block text-sm text-gray-300">{l}<input name={n} defaultValue={v} className={box} /></label>
        ))}
        {([['instructions', 'Drop-off instructions', cfg.instructions], ['cancellationPolicy', 'Cancellation / reschedule policy', cfg.cancellationPolicy]] as const).map(([n, l, v]) => (
          <label key={n} className="block text-sm text-gray-300">{l}<textarea name={n} defaultValue={v} rows={3} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
        ))}
      </section>

      {state && !state.ok && <p role="alert" className="text-sm text-amber-300">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-300">Saved.</p>}
      <button type="submit" disabled={pending} className="min-h-12 w-full rounded-xl bg-emerald-500 font-semibold text-gray-950 disabled:opacity-60">{pending ? 'Saving…' : 'Save settings'}</button>
    </form>
  )
}

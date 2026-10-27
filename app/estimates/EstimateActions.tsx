'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { InvoiceDraft } from '@/apps/workflow/invoice-draft'
import { InvoiceTotals, type ChargeField } from '@/app/orders/[id]/InvoiceDraftPanel'
import { createDraftSequencer, estimateActionsLocked, interpretDraftResponse } from '@/app/orders/[id]/invoice-draft-sync'
import { normalizeRecipients, recipientErrorMessage, MAX_RECIPIENTS } from '@/apps/estimates/recipients'
import { MAX_CUSTOMER_NOTES, reconcileNotes } from '@/apps/estimates/notes'
interface Summary { draft: InvoiceDraft; revision: string; email: string; phone: string; customerNotes: string; qbNumber: string | null; sentAt: string | null }
const money = (c: number) => `$${(c / 100).toFixed(2)}`
/**
 * Customer estimate: the money once (subtotal from the editor above, then shop supplies / card charge
 * each with Remove/Restore, tax, total) and the estimate actions. Fee choices go through the same
 * Invoice Draft override + fee engine as a Job (stored on the Job estimate, so they carry over when the
 * estimate moves to the Work Board, and the QuickBooks estimate/invoice uses them). Removing or
 * restoring never sends anything.
 */
interface EstimateActionsProps {
  id: string; editorBusy: boolean; onBusyChange: (busy: boolean) => void
  /** The editable Subtotal row from the estimate editor. */
  subtotal?: ReactNode
  /** Changes after each confirmed item edit → re-read the summary (total + revision) in place. */
  refreshKey?: string
}

/**
 * Keyed by `id` so navigating to a DIFFERENT estimate fully remounts the inner component — every piece of
 * state and every ref (seeded contact, recipient drafts, a frozen send confirmation) resets, so nothing
 * leaks from one customer to the next. A `refreshKey` change does NOT change the key, so in-place edits and
 * typed recipient drafts are preserved while the summary re-reads.
 */
export default function EstimateActions(props: EstimateActionsProps) {
  return <EstimateActionsInner key={props.id} {...props} />
}

function EstimateActionsInner({ id, editorBusy, onBusyChange, subtotal, refreshKey }: EstimateActionsProps) {
  const router = useRouter()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  // Re-reading the summary after an item edit: actions are disabled until the authoritative total lands.
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<'send' | 'convert' | null>(null)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [contactOpen, setContactOpen] = useState(false)
  // Explicit PER-SEND recipient drafts (the text being typed). Seeded once from the saved customer email;
  // kept distinct from the contact email and NEVER silently overwritten by a refresh or a contact save.
  const [recipients, setRecipients] = useState<string[]>([''])
  const [recipientError, setRecipientError] = useState('')
  // Customer-visible notes. `notes` is the textarea draft; `savedNotes` is the server-authoritative value
  // (also mirrored in a ref so a background refresh can tell an untouched draft from an edited one without a
  // stale closure). A refresh ADOPTS the server value only when the draft is clean — an in-progress edit is
  // never clobbered, and the revision guard blocks a stale save from overwriting someone else's notes.
  const [notes, setNotes] = useState('')
  const [savedNotes, setSavedNotes] = useState('')
  const savedNotesRef = useRef('')   // the baseline the current draft is edited against (saved value)
  const notesRef = useRef('')         // current draft, readable inside async reconcile without a stale closure
  const setSaved = useCallback((v: string) => { savedNotesRef.current = v; setSavedNotes(v) }, [])
  const [savingNotes, setSavingNotes] = useState(false)
  const [notesError, setNotesError] = useState('')
  const [notesSaved, setNotesSaved] = useState(false)
  // When set, the saved notes changed in another session while this draft was dirty — holds the OTHER
  // session's value so we can show it and block a save that would silently overwrite it.
  const [notesConflict, setNotesConflict] = useState<string | null>(null)
  // The recipient SET snapshotted when the send confirmation opened — the frozen list that is displayed and
  // submitted. A refresh closes the confirmation (below), so a stale set can never be sent.
  const [frozen, setFrozen] = useState<string[] | null>(null)
  // Contact + recipient fields are seeded once; later refreshes must not overwrite what is being typed.
  const seededRef = useRef(false)
  // Only the most recently started read (initial load, refresh after an item edit, or a fee toggle's own
  // reload) may write `summary`, so an older response can't resurrect a stale total/revision.
  const seq = useRef(createDraftSequencer()).current
  const didInit = useRef(false)
  const locked = estimateActionsLocked({ busy, editorBusy, refreshing })

  // Keep notesRef in sync so the async reconcile below reads the live draft, not a stale closure.
  useEffect(() => { notesRef.current = notes }, [notes])
  // Reconcile a freshly-read server notes value with the current draft (PURE decision in reconcileNotes):
  // adopt into a clean draft, keep a dirty draft, or flag a conflict when the saved notes changed under a
  // dirty draft — never silently overwriting another session.
  const applyServerNotes = useCallback((serverNotes: string) => {
    const r = reconcileNotes({ serverNotes, draft: notesRef.current, baseline: savedNotesRef.current })
    if (r.draft !== undefined) { notesRef.current = r.draft; setNotes(r.draft) }
    setSaved(r.baseline)
    setNotesConflict(r.conflict)
  }, [setSaved])

  // Read the estimate summary. 'refresh' = the items changed underneath (or a fee toggle just saved): mark
  // refreshing (actions disabled), drop any open confirmation, and FAIL CLOSED on any failure — a non-2xx,
  // a missing/malformed draft, or a network error clears the stale summary so Send / Move can't act on an
  // old revision; a Retry re-reads it. Only the latest read may apply, and the finally always settles the
  // current read, so no request can strand a permanent refreshing state across id / key changes.
  const loadSummary = useCallback(async (mode: 'initial' | 'refresh') => {
    const token = seq.begin()
    if (mode === 'refresh') { setRefreshing(true); setConfirm(null); setMessage(''); setRecipientError('') }
    try {
      const r = await fetch(`/api/estimates/${id}`, { cache: 'no-store' })
      const d = await r.json().catch(() => null) as (Summary & { error?: string }) | null
      if (!seq.isCurrent(token)) return
      // Fail closed: only a 2xx response carrying a real draft is usable. Anything else drops the stale
      // summary (on a refresh) so Send / Move can't act on an old revision.
      const res = interpretDraftResponse(r.ok, d, 'Unable to load total.')
      if (!res.draft) { setError(res.error ?? 'Unable to load total.'); if (mode === 'refresh') setSummary(null); return }
      setSummary(d as Summary); setError('')
      const s = d as Summary
      if (!seededRef.current) {
        setEmail(s.email); setPhone(s.phone); setRecipients(s.email ? [s.email] : [''])
        seededRef.current = true
      }
      // Reconcile notes on every read (seed included, where the empty baseline adopts the saved value).
      applyServerNotes(s.customerNotes ?? '')
    } catch {
      if (!seq.isCurrent(token)) return
      setError('Unable to load total.')
      if (mode === 'refresh') setSummary(null)   // fail closed on a refresh; the initial load had nothing to drop
    } finally {
      if (seq.isCurrent(token)) setRefreshing(false)
    }
  }, [id, seq, applyServerNotes])

  useEffect(() => {
    const first = !didInit.current
    didInit.current = true
    void loadSummary(first ? 'initial' : 'refresh')
  }, [id, refreshKey, loadSummary])

  const action = async (kind: 'contact' | 'send' | 'convert', sendRecipients?: string[]) => {
    if (locked || !summary) return
    setBusy(true); onBusyChange(true); setError(''); setMessage('')
    try {
      const response = await fetch(`/api/estimates/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Send carries the frozen recipient SET; contact save never touches recipients.
        body: JSON.stringify({ action: kind, revision: summary.revision, email, phone, ...(kind === 'send' && sendRecipients ? { recipients: sendRecipients } : {}) }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to complete action.')
      if (data.converted) { router.push(`/orders/${id}`); return }
      // This response carries a fresh revision + the authoritative notes; reconcile so a contact/send reply
      // can't silently adopt another session's notes under a dirty draft either.
      setSummary(data); setEmail(data.email); setPhone(data.phone); setContactOpen(false)
      applyServerNotes(data.customerNotes ?? '')
      setMessage(kind === 'send' ? 'QuickBooks confirmed the estimate was sent.' : 'Contact details saved.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete action.') }
    finally { setBusy(false); onBusyChange(false); setConfirm(null) }
  }
  // Unsaved notes must be committed before a Send/Move can reference this revision — otherwise QuickBooks
  // would get the OLD memo while the manager thinks the typed notes are included.
  const notesDirty = notes !== savedNotes
  // Save ONLY the notes (no send, no QB sync, no pricing change). Uses the current revision so a stale
  // save is rejected server-side; failure keeps the typed text so nothing is lost. Any open confirmation is
  // cancelled first because the revision is about to change.
  const saveNotes = async () => {
    if (locked || !summary) return
    // A pending conflict means the saved notes changed elsewhere — refuse to overwrite blindly; the manager
    // must explicitly reload the saved notes (which preserves their draft until they click) and reapply.
    if (notesConflict !== null) { setNotesError('These notes were changed in another session. Reload the saved notes, then reapply your changes.'); return }
    setConfirm(null); setBusy(true); onBusyChange(true); setSavingNotes(true)
    setError(''); setMessage(''); setNotesError(''); setNotesSaved(false)
    try {
      const response = await fetch(`/api/estimates/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'notes', revision: summary.revision, notes }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save notes.')
      // Adopt the server's normalized notes + fresh summary (new revision) so Send/Move now carry them.
      setSummary(data); notesRef.current = data.customerNotes ?? ''
      setNotes(data.customerNotes ?? ''); setSaved(data.customerNotes ?? ''); setNotesConflict(null); setNotesSaved(true)
    } catch (e) { setNotesError(e instanceof Error ? e.message : 'Unable to save notes.') }   // text preserved
    finally { setBusy(false); onBusyChange(false); setSavingNotes(false) }
  }
  // Explicitly resolve a conflict: pull the OTHER session's saved notes into the editor (clearing the
  // conflict). Only happens on an explicit click, so the dirty draft is never discarded silently.
  const reloadSavedNotes = () => {
    if (notesConflict === null) return
    notesRef.current = notesConflict
    setNotes(notesConflict); setSaved(notesConflict); setNotesConflict(null); setNotesSaved(false); setNotesError('')
  }
  // Open the send confirmation only with a valid recipient SET — validated and FROZEN here so the dialog
  // displays and submits exactly that normalized list. An invalid list surfaces an inline error instead.
  // A conflict is blocked even when the draft was edited back to its (now-stale) baseline: the saved notes
  // still differ on the server, so the confirmation would show the OLD notes while the send carries the newer
  // server value. Resolve the conflict (reload) first, then save, then send/move.
  const openSendConfirm = () => {
    if (locked || !summary) return
    if (notesConflict !== null) { setNotesError('These notes were changed in another session. Reload the saved notes, then reapply your changes before sending.'); return }
    if (notesDirty) { setNotesError('Save your notes before sending — they go on the estimate.'); return }
    const norm = normalizeRecipients(recipients)
    if (!norm.ok) { setRecipientError(recipientErrorMessage(norm.reason)); return }
    setRecipientError(''); setFrozen(norm.list); setConfirm('send')
  }
  const openConvertConfirm = () => {
    if (locked || !summary) return
    if (notesConflict !== null) { setNotesError('These notes were changed in another session. Reload the saved notes, then reapply your changes before moving this.'); return }
    if (notesDirty) { setNotesError('Save your notes before moving this to the Work Board.'); return }
    setConfirm('convert')
  }
  const setRecipient = (i: number, value: string) => setRecipients(r => r.map((v, j) => (j === i ? value : v)))
  const addRecipient = () => setRecipients(r => (r.length >= MAX_RECIPIENTS ? r : [...r, '']))
  const removeRecipient = (i: number) => setRecipients(r => (r.length <= 1 ? r : r.filter((_, j) => j !== i)))
  // Remove / Restore shop supplies or the card charge — the Invoice Draft override (manager/admin,
  // audited, recomputed by the fee engine). Then re-read the summary: its total and revision changed.
  const toggleFee = async (field: ChargeField, removed: boolean) => {
    if (locked) return
    setBusy(true); onBusyChange(true); setError(''); setMessage(''); setConfirm(null)
    const token = seq.begin()
    try {
      const response = await fetch(`/api/workflow/orders/${id}/invoice/override`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, removed }) })
      const data = await response.json().catch(() => ({}))
      // The override POST failed → nothing changed server-side, so the current total is still correct: keep it.
      if (!response.ok) throw new Error(data.error || 'That change was not saved.')
      // Saved: the shown total/revision is now stale. Invalidate it IMMEDIATELY so nothing actionable can
      // survive even if the reload then fails (network / malformed / missing draft); it is restored only by
      // a validated refresh. loadSummary fails closed (summary stays null) and surfaces a Retry.
      if (seq.isCurrent(token)) setSummary(null)
      await loadSummary('refresh')
    } catch (e) { if (seq.isCurrent(token)) setError(e instanceof Error ? e.message : 'That change was not saved.') }
    finally { setBusy(false); onBusyChange(false) }
  }
  return <section className="mt-4 rounded-2xl border border-gray-800 bg-gray-900 px-4 py-2 pb-4 space-y-3">
    <h2 className="sr-only">Customer estimate</h2>
    {summary && !refreshing ? <>
      <InvoiceTotals draft={summary.draft} subtotal={subtotal} canEdit={summary.draft.priced} busy={locked} onToggle={(f, r) => { void toggleFee(f, r) }} totalLabel="Estimate total" />
      <p className="text-gray-400 text-sm">Customer contact: {summary.email || 'No email added'} <button disabled={locked} onClick={() => setContactOpen(!contactOpen)} className="text-blue-400 ml-1 min-h-11 px-1 inline-flex items-center">Edit contact</button></p>
      {contactOpen && <form className="space-y-3" onSubmit={e => { e.preventDefault(); void action('contact') }}>
        <label className="block text-sm">Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3" /></label>
        <label className="block text-sm">Phone<input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3" /></label>
        <button disabled={locked} className="rounded-lg bg-gray-800 px-4 py-2">Save contact</button>
      </form>}
      {/* Explicit per-send recipients — distinct from the saved contact above; editing is hidden while a
          confirmation is open so the frozen list is the only thing that can be sent. */}
      {!confirm && <fieldset disabled={locked} className="space-y-2 border-0 p-0 m-0">
        <legend className="text-sm text-gray-300">Email this estimate to</legend>
        <p className="text-gray-500 text-xs">These addresses receive this estimate for this send only. The customer’s saved contact isn’t changed.</p>
        {recipients.map((value, i) => <div key={i} className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`recipient-${id}-${i}`}>{`Recipient ${i + 1}`}</label>
          <input id={`recipient-${id}-${i}`} type="email" inputMode="email" autoComplete="off" value={value} placeholder="name@example.com"
            onChange={e => setRecipient(i, e.target.value)} className="flex-1 min-w-0 min-h-11 rounded-lg bg-gray-900 border border-gray-700 p-3" />
          <button type="button" onClick={() => removeRecipient(i)} disabled={locked || recipients.length <= 1}
            aria-label={`Remove recipient ${i + 1}`} className="min-h-11 min-w-11 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40">Remove</button>
        </div>)}
        <button type="button" onClick={addRecipient} disabled={locked || recipients.length >= MAX_RECIPIENTS} className="text-blue-400 min-h-11 px-1 inline-flex items-center disabled:opacity-40">+ Add recipient</button>
        {recipientError && <p role="alert" className="text-red-400 text-sm">{recipientError}</p>}
      </fieldset>}
      {/* Customer-visible notes (e.g. an insurance claim number). Shown on the estimate; must be SAVED
          before a Send/Move so QuickBooks gets what the manager sees. Hidden while a confirmation is open —
          the frozen saved notes are shown in the dialog instead. */}
      {!confirm && <div className="space-y-2">
        <label htmlFor={`notes-${id}`} className="block text-sm text-gray-300 font-medium">Notes on estimate</label>
        <p id={`notes-help-${id}`} className="text-gray-500 text-xs">Shown to the customer and to any insurer you email this estimate to — e.g. an insurance claim number. These appear on the estimate in QuickBooks.</p>
        <textarea id={`notes-${id}`} value={notes} disabled={locked} rows={3} maxLength={MAX_CUSTOMER_NOTES}
          placeholder="Claim number: …" aria-describedby={`notes-help-${id} notes-count-${id}`}
          onChange={e => { setNotes(e.target.value); setConfirm(null); setNotesSaved(false); setNotesError('') }}
          className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3 text-base" />
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => void saveNotes()} disabled={locked || !notesDirty || notesConflict !== null}
            className="rounded-lg bg-gray-800 px-4 py-2 min-h-11 disabled:opacity-40">{savingNotes ? 'Saving…' : 'Save notes'}</button>
          <span id={`notes-count-${id}`} className="text-gray-500 text-xs">{notes.length}/{MAX_CUSTOMER_NOTES}</span>
        </div>
        {/* Another session saved different notes while this draft was unsaved: show their value and keep the
            draft; the manager explicitly reloads (then reapplies) rather than overwriting them unseen. */}
        {notesConflict !== null && <div role="alert" className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm space-y-2">
          <p className="text-amber-300">These notes were changed in another session. Your unsaved text is kept above.</p>
          <p className="text-gray-300"><span className="font-medium">Now saved:</span> <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{notesConflict || '(no notes)'}</span></p>
          <button type="button" onClick={reloadSavedNotes} disabled={locked} className="rounded-lg bg-gray-800 px-3 py-2 min-h-11 disabled:opacity-40">Reload saved notes</button>
        </div>}
        {notesConflict === null && notesDirty && !notesError && <p className="text-amber-400 text-xs">Unsaved notes — save them before sending or moving.</p>}
        {notesError && <p role="alert" aria-live="polite" className="text-red-400 text-sm">{notesError}</p>}
        {notesSaved && !notesDirty && <p role="status" aria-live="polite" className="text-green-400 text-sm">Notes saved — they’ll appear on the estimate.</p>}
      </div>}
      {summary.qbNumber && <p className="text-gray-500 text-xs">QuickBooks estimate #{summary.qbNumber}{summary.sentAt ? ` · Last sent ${new Date(summary.sentAt).toLocaleString()}` : ''}</p>}
      {/* While a confirmation is open it is the only way forward — the original buttons are hidden. */}
      {!confirm && <>
        <button disabled={locked || !summary.draft.priced || contactOpen || !recipients.some(r => r.trim())} onClick={openSendConfirm} className="w-full bg-blue-600 rounded-xl py-3 font-semibold disabled:opacity-40">{busy ? 'Working…' : summary.qbNumber ? 'Send current estimate through QuickBooks' : 'Send estimate through QuickBooks'}</button>
        <button disabled={locked || !summary.draft.priced || contactOpen} onClick={openConvertConfirm} className="w-full border border-gray-600 rounded-xl py-3 font-semibold disabled:opacity-40">Move to Work Board</button>
      </>}
      {confirm === 'send' && frozen && <div role="alertdialog" aria-label="Confirm estimate email" className="rounded-xl bg-gray-950 border border-blue-700 p-4 space-y-3">
        <p>{`Send this ${money(summary.draft.totalCents)} estimate through QuickBooks to:`}</p>
        <ul className="list-disc pl-5 text-sm">{frozen.map(a => <li key={a} className="break-words [overflow-wrap:anywhere]">{a}</li>)}</ul>
        {savedNotes && <div className="text-sm text-gray-300"><p className="font-medium">Notes on this estimate:</p><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{savedNotes}</p></div>}
        <p className="text-gray-400 text-sm">Any existing QuickBooks estimate will be updated to these prices.</p>
        <button disabled={locked} onClick={() => action('send', frozen)} className="bg-blue-600 rounded-lg px-4 py-2 mr-3 disabled:opacity-40">Send estimate</button>
        <button disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
      </div>}
      {confirm === 'convert' && <div role="alertdialog" aria-labelledby={`move-${id}`} className="rounded-xl bg-gray-950 border border-blue-700 p-4">
        <p id={`move-${id}`} className="font-semibold text-white">Move this job to the Work Board?</p>
        <div className="mt-3 flex gap-2">
          <button disabled={locked} onClick={() => action('convert')} className="flex-1 min-h-11 rounded-lg bg-blue-600 font-semibold disabled:opacity-40">{busy ? 'Moving…' : 'Yes'}</button>
          <button disabled={busy} onClick={() => setConfirm(null)} className="flex-1 min-h-11 rounded-lg border border-gray-600 font-semibold disabled:opacity-40">No</button>
        </div>
      </div>}
    </> : <>{subtotal}
      {/* While refreshing, show the editable subtotal with a plain "Updating totals…" — never the new
          subtotal mixed with the old charges/total. A failed refresh shows no stale total, only Retry. */}
      {refreshing
        ? <p role="status" aria-live="polite" className="text-gray-400 text-sm">Updating totals…</p>
        : error
          ? <p role="alert" className="text-red-400 text-sm">{error} <button type="button" onClick={() => void loadSummary('refresh')} className="underline">Retry</button></p>
          : <p className="text-gray-400 text-sm">Loading estimate total…</p>}
    </>}
    {/* Action errors (send / move / fee POST) show here while the current total is still displayed; a LOAD
        error is surfaced with Retry in the branch above instead. */}
    {error && summary && !refreshing && <p role="alert" className="text-red-400 text-sm">{error} <button onClick={() => window.location.reload()} className="underline">Refresh</button></p>}
    {message && <p role="status" className="text-green-400 text-sm">{message}</p>}
  </section>
}

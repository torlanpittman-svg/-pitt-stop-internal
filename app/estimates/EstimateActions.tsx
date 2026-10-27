'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { InvoiceDraft } from '@/apps/workflow/invoice-draft'
import { InvoiceTotals, type ChargeField } from '@/app/orders/[id]/InvoiceDraftPanel'
import { createDraftSequencer, estimateActionsLocked, interpretDraftResponse } from '@/app/orders/[id]/invoice-draft-sync'
import { normalizeRecipients, recipientErrorMessage, MAX_RECIPIENTS } from '@/apps/estimates/recipients'
import { decideRecipientSave, normalizeBaseline, recipientSaveTarget, sameRecipientList,
  readRecipientDraft, writeRecipientDraft, clearRecipientDraft, RECIPIENT_SAVE_DEBOUNCE_MS } from '@/apps/estimates/recipient-autosave'
import { MAX_CUSTOMER_NOTES, reconcileNotes } from '@/apps/estimates/notes'
interface Summary { draft: InvoiceDraft; revision: string; email: string; phone: string; customerNotes: string; savedRecipients: string[] | null; qbNumber: string | null; sentAt: string | null }
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
  const summaryRef = useRef<Summary | null>(null)   // current summary, readable inside async autosave closures
  const [busy, setBusy] = useState(false)
  // Re-reading the summary after an item edit: actions are disabled until the authoritative total lands.
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<'send' | 'convert' | null>(null)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [contactOpen, setContactOpen] = useState(false)
  // Per-estimate recipient drafts (the text being typed). Seeded from the saved recipient list (or, for a
  // legacy estimate with none, the saved contact email); kept distinct from the contact and NEVER silently
  // overwritten by a refresh or a contact save. Valid changes AUTO-SAVE (debounced / on blur) so backing out
  // and returning keeps them — see the autosave block below.
  const [recipients, setRecipients] = useState<string[]>([''])
  const recipientsRef = useRef<string[]>([''])                 // live editor, readable inside async closures
  const recipientsBaselineRef = useRef<string[]>([])           // the normalized last-saved SET the draft is diffed against
  const seededRecipientsRef = useRef(false)
  const savingRecipientsRef = useRef(false)                    // a save is in flight (prevents overlapping writes)
  const mountedRef = useRef(true)
  const recipientFailureRef = useRef<string | null>(null)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const recipientSaveSeq = useRef(0)                           // only the newest save's response may apply (stale-safe)
  const recipientDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [savingRecipients, setSavingRecipients] = useState(false)
  const [recipientStatus, setRecipientStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'blocked'>('idle')
  const [recipientSaveError, setRecipientSaveError] = useState('')
  const [recipientError, setRecipientError] = useState('')     // send-confirmation validation (separate from autosave)
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
  const actionsLocked = locked || savingRecipients

  // Keep notesRef in sync so the async reconcile below reads the live draft, not a stale closure.
  useEffect(() => { notesRef.current = notes }, [notes])
  // Mirror the live editor + summary into refs so the autosave (debounced / blur) reads current values.
  useEffect(() => { recipientsRef.current = recipients }, [recipients])
  useEffect(() => { summaryRef.current = summary }, [summary])

  // Seed (first read) or reconcile (a later refresh) the recipient editor against the server. On SEED, a
  // per-estimate localStorage draft carrying unsaved text wins (reliable quick back/reopen), otherwise the
  // saved list / contact fallback. On a REFRESH, the server value is adopted ONLY into a clean, not-saving
  // editor — an in-progress draft is never clobbered; the revision guard protects a later save. `savedSet`
  // is the authoritative baseline: the saved list when non-null, else the contact email (legacy).
  const applyServerRecipients = useCallback((savedRecipients: string[] | null, contactEmail: string) => {
    const savedSet = savedRecipients !== null ? normalizeBaseline(savedRecipients) : normalizeBaseline(contactEmail ? [contactEmail] : [])
    if (!seededRecipientsRef.current) {
      seededRecipientsRef.current = true
      recipientsBaselineRef.current = savedSet
      const draft = readRecipientDraft(id)
      let initial: string[]
      if (draft) {
        const dt = recipientSaveTarget(draft)
        const carriesUnsaved = !dt.ok || !sameRecipientList(dt.list, savedSet)
        initial = carriesUnsaved ? draft : (savedSet.length ? savedSet : [''])
      } else initial = savedSet.length ? savedSet : ['']
      recipientsRef.current = initial
      setRecipients(initial)
      return
    }
    const t = recipientSaveTarget(recipientsRef.current)
    const dirty = !t.ok || !sameRecipientList(t.list, recipientsBaselineRef.current)
    if (!dirty && !savingRecipientsRef.current) {
      recipientsBaselineRef.current = savedSet
      const next = savedSet.length ? savedSet : ['']
      recipientsRef.current = next
      setRecipients(next)
    }
  }, [id])
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
        setEmail(s.email); setPhone(s.phone)
        seededRef.current = true
      }
      // Seed/reconcile recipients + notes on every read; both keep an in-progress draft and never clobber it.
      applyServerRecipients(s.savedRecipients ?? null, s.email)
      applyServerNotes(s.customerNotes ?? '')
    } catch {
      if (!seq.isCurrent(token)) return
      setError('Unable to load total.')
      if (mode === 'refresh') setSummary(null)   // fail closed on a refresh; the initial load had nothing to drop
    } finally {
      if (seq.isCurrent(token)) setRefreshing(false)
    }
  }, [id, seq, applyServerNotes, applyServerRecipients])

  useEffect(() => {
    const first = !didInit.current
    didInit.current = true
    void loadSummary(first ? 'initial' : 'refresh')
  }, [id, refreshKey, loadSummary])

  const action = async (kind: 'contact' | 'send' | 'convert', sendRecipients?: string[]) => {
    if (actionsLocked || savingRecipientsRef.current || !summary) return
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
      applyServerRecipients(data.savedRecipients ?? null, data.email)
      applyServerNotes(data.customerNotes ?? '')
      setMessage(kind === 'send' ? 'QuickBooks confirmed the estimate was sent.' : 'Contact details saved.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete action.') }
    finally { setBusy(false); onBusyChange(false); setConfirm(null) }
  }

  // Persist the recipient list for THIS estimate — no send, no QuickBooks, no pricing/contact change. Uses
  // the current revision so a stale/concurrently-changed estimate is rejected server-side. A monotonic token
  // means only the newest save's response applies (stale responses are dropped), and savingRecipientsRef
  // blocks an overlapping write. On success the editor's text is kept (the server normalizes for storage),
  // the baseline advances, the local draft is cleared, and the fresh summary (new revision) is adopted.
  const saveRecipients = useCallback(async (list: string[]) => {
    if (!summaryRef.current || savingRecipientsRef.current) return
    const token = ++recipientSaveSeq.current
    seq.begin() // An older summary read must not replace this save's newer revision.
    savingRecipientsRef.current = true
    onBusyChange(true)
    setSavingRecipients(true); setRecipientStatus('saving'); setRecipientSaveError('')
    try {
      const response = await fetch(`/api/estimates/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_recipients', revision: summaryRef.current.revision, recipients: list }) })
      const data = await response.json().catch(() => null)
      if (token !== recipientSaveSeq.current) return   // a newer save superseded this one — ignore the response
      if (!response.ok || !data) throw new Error(data?.error || 'Unable to save recipients.')
      // A slow response must never erase typing made after this request (including after unmount).
      const storedDraft = readRecipientDraft(id)
      const storedTarget = storedDraft && recipientSaveTarget(storedDraft)
      if (storedTarget && storedTarget.ok && sameRecipientList(storedTarget.list, list)) clearRecipientDraft(id)
      if (!mountedRef.current) return
      recipientsBaselineRef.current = list
      summaryRef.current = data
      setSummary(data)
      applyServerNotes(data.customerNotes ?? '')   // adopt the fresh revision's notes without clobbering a dirty draft
      recipientFailureRef.current = null
      setRecipientStatus('saved')
    } catch (e) {
      if (token !== recipientSaveSeq.current || !mountedRef.current) return
      recipientFailureRef.current = JSON.stringify(list)
      setRecipientStatus('error'); setRecipientSaveError(e instanceof Error ? e.message : 'Unable to save recipients.')
    } finally {
      if (token === recipientSaveSeq.current && mountedRef.current) { savingRecipientsRef.current = false; setSavingRecipients(false); onBusyChange(false) }
    }
  }, [id, applyServerNotes, onBusyChange, seq])

  // Autosave the recipients after a brief debounce whenever the valid set differs from what's saved. A blank
  // row never blocks (it's dropped); an invalid entry is held as 'blocked' and never persisted. The raw rows
  // are mirrored to a per-estimate localStorage draft on every change (recovers a quick back/reopen even
  // mid-debounce) and cleared once idle/saved. Skipped while locked (a send/move/fee/refresh is settling) or
  // while a confirmation is frozen — the revision is about to change or is being acted on.
  useEffect(() => {
    if (!seededRecipientsRef.current || locked || confirm) return
    const decision = decideRecipientSave(recipients, recipientsBaselineRef.current)
    if (decision.kind === 'idle') {
      clearRecipientDraft(id)
      setRecipientStatus(s => (s === 'blocked' || s === 'error') ? 'idle' : s)
      return
    }
    writeRecipientDraft(id, recipients)
    if (decision.kind === 'blocked') { setRecipientStatus('blocked'); return }
    if (recipientFailureRef.current === JSON.stringify(decision.list)) return
    setRecipientStatus('saving')
    if (savingRecipientsRef.current) return   // a save is in flight; its completion re-runs this effect
    recipientDebounceRef.current = setTimeout(() => { void saveRecipients(decision.list) }, RECIPIENT_SAVE_DEBOUNCE_MS)
    return () => { if (recipientDebounceRef.current) { clearTimeout(recipientDebounceRef.current); recipientDebounceRef.current = null } }
  }, [recipients, locked, confirm, savingRecipients, saveRecipients, id])

  // Blur / remove flush: save immediately rather than wait out the debounce (snappier, and more robust if the
  // manager navigates away right after). No-op when locked, mid-confirmation, already saving, or nothing changed.
  const flushRecipients = useCallback(() => {
    if (recipientDebounceRef.current) { clearTimeout(recipientDebounceRef.current); recipientDebounceRef.current = null }
    if (!seededRecipientsRef.current || locked || confirm || savingRecipientsRef.current) return
    const decision = decideRecipientSave(recipientsRef.current, recipientsBaselineRef.current)
    if (decision.kind === 'save' && recipientFailureRef.current !== JSON.stringify(decision.list)) void saveRecipients(decision.list)
  }, [locked, confirm, saveRecipients])

  // Unsaved notes must be committed before a Send/Move can reference this revision — otherwise QuickBooks
  // would get the OLD memo while the manager thinks the typed notes are included.
  const notesDirty = notes !== savedNotes
  // Save ONLY the notes (no send, no QB sync, no pricing change). Uses the current revision so a stale
  // save is rejected server-side; failure keeps the typed text so nothing is lost. Any open confirmation is
  // cancelled first because the revision is about to change.
  const saveNotes = async () => {
    if (actionsLocked || savingRecipientsRef.current || !summary) return
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
    if (actionsLocked || savingRecipientsRef.current || !summary) return
    if (notesConflict !== null) { setNotesError('These notes were changed in another session. Reload the saved notes, then reapply your changes before sending.'); return }
    if (notesDirty) { setNotesError('Save your notes before sending — they go on the estimate.'); return }
    const norm = normalizeRecipients(recipients)
    if (!norm.ok) { setRecipientError(recipientErrorMessage(norm.reason)); return }
    setRecipientError(''); setFrozen(norm.list); setConfirm('send')
  }
  const openConvertConfirm = () => {
    if (actionsLocked || savingRecipientsRef.current || !summary) return
    if (notesConflict !== null) { setNotesError('These notes were changed in another session. Reload the saved notes, then reapply your changes before moving this.'); return }
    if (notesDirty) { setNotesError('Save your notes before moving this to the Work Board.'); return }
    setConfirm('convert')
  }
  const editRecipients = (next: string[]) => {
    recipientsRef.current = next
    writeRecipientDraft(id, next) // Synchronous recovery even if navigation precedes the next effect.
    recipientFailureRef.current = null
    setRecipientStatus('idle'); setRecipientSaveError(''); setConfirm(null)
    setRecipients(next)
  }
  const setRecipient = (i: number, value: string) => editRecipients(recipientsRef.current.map((v, j) => j === i ? value : v))
  const addRecipient = () => { if (recipientsRef.current.length < MAX_RECIPIENTS) editRecipients([...recipientsRef.current, '']) }
  const removeRecipient = (i: number) => { if (recipientsRef.current.length > 1) editRecipients(recipientsRef.current.filter((_, j) => j !== i)) }
  const retryRecipients = async () => {
    if (locked || savingRecipientsRef.current) return
    try {
      const readToken = seq.begin()
      const response = await fetch(`/api/estimates/${id}`, { cache: 'no-store' })
      const data = await response.json()
      if (!mountedRef.current || !seq.isCurrent(readToken)) return
      if (!response.ok || !data?.draft) throw new Error(data?.error || 'Unable to refresh recipients.')
      const saved = normalizeBaseline(data.savedRecipients ?? (data.email ? [data.email] : []))
      const target = recipientSaveTarget(recipientsRef.current)
      if (!target.ok) throw new Error(recipientErrorMessage(target.reason))
      if (!sameRecipientList(saved, recipientsBaselineRef.current) && !sameRecipientList(saved, target.list)) {
        throw new Error('Recipients changed in another session. Reopen the estimate and review them before retrying.')
      }
      summaryRef.current = data; setSummary(data); applyServerNotes(data.customerNotes ?? '')
      recipientsBaselineRef.current = saved; recipientFailureRef.current = null
      if (sameRecipientList(saved, target.list)) { clearRecipientDraft(id); setRecipientStatus('saved') }
      else await saveRecipients(target.list)
    } catch (e) { setRecipientStatus('error'); setRecipientSaveError(e instanceof Error ? e.message : 'Unable to save recipients.') }
  }
  // Remove / Restore shop supplies or the card charge — the Invoice Draft override (manager/admin,
  // audited, recomputed by the fee engine). Then re-read the summary: its total and revision changed.
  const toggleFee = async (field: ChargeField, removed: boolean) => {
    if (actionsLocked || savingRecipientsRef.current) return
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
      <InvoiceTotals draft={summary.draft} subtotal={subtotal} canEdit={summary.draft.priced} busy={actionsLocked} onToggle={(f, r) => { void toggleFee(f, r) }} totalLabel="Estimate total" />
      <p className="text-gray-400 text-sm">Customer contact: {summary.email || 'No email added'} <button disabled={actionsLocked} onClick={() => setContactOpen(!contactOpen)} className="text-blue-400 ml-1 min-h-11 px-1 inline-flex items-center">Edit contact</button></p>
      {contactOpen && <form className="space-y-3" onSubmit={e => { e.preventDefault(); void action('contact') }}>
        <label className="block text-sm">Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3" /></label>
        <label className="block text-sm">Phone<input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3" /></label>
        <button disabled={actionsLocked} className="rounded-lg bg-gray-800 px-4 py-2">Save contact</button>
      </form>}
      {/* Per-estimate recipients — distinct from the saved contact above; saved automatically as they're
          edited so backing out and returning keeps them. Editing is hidden while a confirmation is open so
          the frozen list is the only thing that can be sent. */}
      {!confirm && <fieldset disabled={locked} className="space-y-2 border-0 p-0 m-0">
        <legend className="text-sm text-gray-300">Email this estimate to</legend>
        <p className="text-gray-500 text-xs">These addresses are saved with this estimate and used when you send it. They don’t change the customer’s saved contact.</p>
        {recipients.map((value, i) => <div key={i} className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`recipient-${id}-${i}`}>{`Recipient ${i + 1}`}</label>
          <input id={`recipient-${id}-${i}`} type="email" inputMode="email" autoComplete="off" value={value} placeholder="name@example.com"
            onChange={e => setRecipient(i, e.target.value)} onBlur={flushRecipients} className="flex-1 min-w-0 min-h-11 rounded-lg bg-gray-900 border border-gray-700 p-3" />
          <button type="button" onClick={() => removeRecipient(i)} disabled={locked || recipients.length <= 1}
            aria-label={`Remove recipient ${i + 1}`} className="min-h-11 min-w-11 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40">Remove</button>
        </div>)}
        <button type="button" onClick={addRecipient} disabled={locked || recipients.length >= MAX_RECIPIENTS} className="text-blue-400 min-h-11 px-1 inline-flex items-center disabled:opacity-40">+ Add recipient</button>
        {/* Compact autosave status. 'blocked' = an invalid address won't be saved/sent; 'error' offers a retry. */}
        {recipientStatus === 'saving' && <p role="status" aria-live="polite" className="text-gray-400 text-xs">Saving recipients…</p>}
        {recipientStatus === 'saved' && <p role="status" aria-live="polite" className="text-green-400 text-xs">Recipients saved.</p>}
        {recipientStatus === 'blocked' && <p role="alert" className="text-amber-400 text-xs">Fix the highlighted address — it isn’t saved or sent.</p>}
        {recipientStatus === 'error' && <p role="alert" aria-live="polite" className="text-red-400 text-xs">{recipientSaveError || 'Couldn’t save recipients.'} <button type="button" onClick={() => void retryRecipients()} className="underline">Retry</button></p>}
        {recipientError && <p role="alert" className="text-red-400 text-sm">{recipientError}</p>}
      </fieldset>}
      {/* Customer-visible notes (e.g. an insurance claim number). Shown on the estimate; must be SAVED
          before a Send/Move so QuickBooks gets what the manager sees. Hidden while a confirmation is open —
          the frozen saved notes are shown in the dialog instead. */}
      {!confirm && <div className="space-y-2">
        <label htmlFor={`notes-${id}`} className="block text-sm text-gray-300 font-medium">Notes on estimate</label>
        <p id={`notes-help-${id}`} className="text-gray-500 text-xs">Shown to the customer and to any insurer you email this estimate to — e.g. an insurance claim number. These appear on the estimate in QuickBooks.</p>
        <textarea id={`notes-${id}`} value={notes} disabled={actionsLocked} rows={3} maxLength={MAX_CUSTOMER_NOTES}
          placeholder="Claim number: …" aria-describedby={`notes-help-${id} notes-count-${id}`}
          onChange={e => { setNotes(e.target.value); setConfirm(null); setNotesSaved(false); setNotesError('') }}
          className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3 text-base" />
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => void saveNotes()} disabled={actionsLocked || !notesDirty || notesConflict !== null}
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
        <button disabled={actionsLocked || !summary.draft.priced || contactOpen || !recipients.some(r => r.trim())} onClick={openSendConfirm} className="w-full bg-blue-600 rounded-xl py-3 font-semibold disabled:opacity-40">{busy ? 'Working…' : summary.qbNumber ? 'Send current estimate through QuickBooks' : 'Send estimate through QuickBooks'}</button>
        <button disabled={actionsLocked || !summary.draft.priced || contactOpen} onClick={openConvertConfirm} className="w-full border border-gray-600 rounded-xl py-3 font-semibold disabled:opacity-40">Move to Work Board</button>
      </>}
      {confirm === 'send' && frozen && <div role="alertdialog" aria-label="Confirm estimate email" className="rounded-xl bg-gray-950 border border-blue-700 p-4 space-y-3">
        <p>{`Send this ${money(summary.draft.totalCents)} estimate through QuickBooks to:`}</p>
        <ul className="list-disc pl-5 text-sm">{frozen.map(a => <li key={a} className="break-words [overflow-wrap:anywhere]">{a}</li>)}</ul>
        {savedNotes && <div className="text-sm text-gray-300"><p className="font-medium">Notes on this estimate:</p><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{savedNotes}</p></div>}
        <p className="text-gray-400 text-sm">Any existing QuickBooks estimate will be updated to these prices.</p>
        <button disabled={actionsLocked} onClick={() => action('send', frozen)} className="bg-blue-600 rounded-lg px-4 py-2 mr-3 disabled:opacity-40">Send estimate</button>
        <button disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
      </div>}
      {confirm === 'convert' && <div role="alertdialog" aria-labelledby={`move-${id}`} className="rounded-xl bg-gray-950 border border-blue-700 p-4">
        <p id={`move-${id}`} className="font-semibold text-white">Move this job to the Work Board?</p>
        <div className="mt-3 flex gap-2">
          <button disabled={actionsLocked} onClick={() => action('convert')} className="flex-1 min-h-11 rounded-lg bg-blue-600 font-semibold disabled:opacity-40">{busy ? 'Moving…' : 'Yes'}</button>
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

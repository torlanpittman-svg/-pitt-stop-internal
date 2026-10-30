'use client'

/**
 * HOMEPAGE "Print Oil Change Sticker" — for the common case where a car gets an oil change and
 * nobody is going to open (or create) a job for it. One tap opens the sticker form directly:
 * current mileage, the shop's 5,000 mi / 6 month prefill (editable, with manual overrides of both
 * computed values), the exact print preview, print.
 *
 * It creates NO job, customer, vehicle, or sticker-history record (see apps/stickers/quick.ts).
 *
 * THE DUPLICATE-PRINT RULE (this is physical paper, so it is strict). All of the decision-making
 * lives in ./oil-sticker-quick-state.ts, which is unit-tested:
 *   - the request is RECORDED (sessionStorage, state 'pending', job null) BEFORE it is dispatched;
 *   - the submitted values are stored resolved and never change for that request, so any retry
 *     re-sends exactly what was shown;
 *   - a lost response comes back as "outcome unknown", and the only thing offered is a STATUS
 *     CHECK of the same token — a new token cannot be minted until a request is resolved;
 *   - a 404 from the status route is not proof that nothing printed, so its retry re-sends the
 *     SAME token (the server keys the print job's primary key on it and answers idempotently);
 *   - nothing is ever re-sent automatically.
 *
 * It is also careful about WHO is at the device: the dialog clears identity-derived state while it
 * re-checks who is signed in, and a saved request belonging to another actor is never adopted.
 * Late replies from a closed dialog (or from a previous actor) are dropped instead of overwriting
 * current state or the saved record.
 *
 * The form, preview, and status wording are shared with the Job detail sheet
 * (./OilStickerForm.tsx) — one design, one calculation, two entry points.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BridgeStatusLine, StickerFields, StickerPreviewCard, stickerStatusLine, useStickerForm,
  type LabelBridgeStatus, type StickerFormState, type StickerJobView,
} from '@/app/components/OilStickerForm'
import {
  QUICK_STORE_KEY, beginRequest, canMintNewRequest, isWaitingStatus, markUnknown, markUnsent,
  planQuickAction, postFailureOutcome, restoreRecord, withJob,
  type QuickRequestRecord, type QuickSubmittedValues,
} from '@/app/components/oil-sticker-quick-state'

type Bootstrap = {
  actorKey: string
  actorName: string | null
  defaults: { intervalMiles: number; intervalMonths: number }
  today: string
  bridge: LabelBridgeStatus
}

const UNREACHABLE = 'Could not reach the shop server. Try the status check again in a moment.'

/** A v4 token, with a fallback for any context where randomUUID() is unavailable. */
function mintRequestId(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The fully resolved values to submit, or null when the form is not yet printable. */
function submittedValues(form: StickerFormState): QuickSubmittedValues | null {
  if (form.mileage === '' || form.nextMileage == null || !form.nextDate) return null
  return {
    mileage: form.mileage,
    intervalMiles: form.intervalMiles === '' ? null : form.intervalMiles,
    intervalMonths: form.intervalMonths === '' ? null : form.intervalMonths,
    nextMileage: form.nextMileage,
    nextDate: form.nextDate,
  }
}

/** Show exactly what a request was sent with (set as explicit overrides, so nothing recomputes). */
function showValues(form: StickerFormState, v: QuickSubmittedValues) {
  form.setMileage(v.mileage)
  form.setIntervalMiles(v.intervalMiles ?? '')
  form.setIntervalMonths(v.intervalMonths ?? '')
  form.setOverrideMiles(v.nextMileage)
  form.setOverrideDate(v.nextDate)
}

function StickerIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4.5h16v11a1 1 0 0 1-.3.7l-3.5 3.5a1 1 0 0 1-.7.3H4z" />
      <path d="M8 9.5h8M8 13h5" />
    </svg>
  )
}

/**
 * Dialog chrome in one plain stylesheet rather than utility classes: a native modal's size and
 * placement have to beat the UA stylesheet's own `max-width`/`inset`/`margin` on the element, and
 * `::backdrop` cannot be styled inline at all. React hoists and de-duplicates this by `href`.
 */
const DIALOG_CSS = `
.ps-sticker-dialog {
  box-sizing: border-box;
  position: fixed;
  inset: 0;
  width: 100%;
  max-width: 34rem;
  max-height: 100%;
  height: fit-content;
  margin: auto;
  padding: 0;
  border: 1px solid #1f2937;
  border-radius: 1.5rem;
  background: #030712;
  color: #fff;
  overflow: hidden;
  overscroll-behavior: contain;
}
.ps-sticker-dialog::backdrop {
  background: rgba(0, 0, 0, 0.65);
  overflow: hidden;
  overscroll-behavior: contain;
}
.ps-sticker-scroll {
  max-height: 92vh; /* fallback first: an engine without dvh keeps a scrollable panel */
  max-height: min(92dvh, 100%);
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
/* Phones: a full-width sheet with room for the home indicator; no rounded corners to waste. */
@media (max-width: 30rem) {
  .ps-sticker-dialog {
    max-width: 100%;
    margin: auto auto 0;
    border-radius: 1.25rem 1.25rem 0 0;
    border-bottom: 0;
  }
  .ps-sticker-scroll { max-height: 94vh; max-height: 94dvh; }
}
`

export default function OilStickerQuickPrint() {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [open, setOpen] = useState(false)

  const [booting, setBooting] = useState(false)
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [record, setRecord] = useState<QuickRequestRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const form = useStickerForm(boot?.today)
  /** Bumped on every open and close. Any reply carrying a stale epoch is dropped — it belongs to a
   *  closed dialog or to a previous actor, and must not touch state or the saved record. */
  const epochRef = useRef(0)
  const openRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastActorRef = useRef<string | null>(null)
  const seededRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])
  useEffect(() => () => stopPolling(), [stopPolling])

  /**
   * The ONLY writer of the request record — state and sessionStorage move together, and never for
   * a stale epoch. Returns false when the write was dropped, so callers stop there.
   */
  const commit = useCallback((epoch: number, next: QuickRequestRecord | null): boolean => {
    if (epoch !== epochRef.current) return false
    setRecord(next)
    try {
      if (next) sessionStorage.setItem(QUICK_STORE_KEY, JSON.stringify(next))
      else sessionStorage.removeItem(QUICK_STORE_KEY)
    } catch { /* private mode: the request still works, it just can't be recovered after a reload */ }
    return true
  }, [])

  // ── Open / close ───────────────────────────────────────────────────────────────────────────────
  /** Clearing identity-derived state belongs to the EVENT that opens the dialog, not to an effect:
   *  it happens in the same render as `open`, so the window never shows a previous actor's request
   *  (or an actionable button) for a frame while the bootstrap is in flight. */
  const openDialog = () => {
    setBooting(true)
    setBoot(null)
    setRecord(null) // state only — the SAVED record stays, to be restored for its own actor
    setLoadError(null)
    setMsg(null)
    setBusy(false)
    setOpen(true)
    dialogRef.current?.showModal()
  }
  const closeDialog = () => dialogRef.current?.close()

  // Native close (Esc, back gesture, Close button). Stops polling and invalidates in-flight work;
  // the saved record stays exactly as it is, so reopening resumes the SAME request.
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const onClose = () => {
      el.returnValue = ''
      epochRef.current++
      openRef.current = false
      stopPolling()
      setBusy(false)
      setOpen(false)
    }
    el.addEventListener('close', onClose)
    return () => el.removeEventListener('close', onClose)
  }, [stopPolling])

  /**
   * On open: ask the server who is signed in, and only then restore this actor's own unfinished
   * request. The state reset already happened in openDialog, so nothing is actionable before this
   * answer arrives. Invalidating the epoch here also discards any reply still owed to a previous
   * open (its `commit` will be dropped).
   */
  useEffect(() => {
    if (!open) return
    const epoch = ++epochRef.current
    openRef.current = true
    stopPolling()

    fetch('/api/oil-sticker')
      .then(async (r) => {
        if (r.status === 401) throw new Error('Sign in on this device to print a sticker.')
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `HTTP ${r.status}`)
        return r.json() as Promise<Bootstrap>
      })
      .then((d) => {
        if (epoch !== epochRef.current) return
        const switchedActor = lastActorRef.current !== null && lastActorRef.current !== d.actorKey
        lastActorRef.current = d.actorKey
        setBoot(d)
        setBooting(false)
        if (switchedActor) { form.setMileage(''); form.resetOverrides(); seededRef.current = false }

        let restored: QuickRequestRecord | null = null
        try { restored = restoreRecord(sessionStorage.getItem(QUICK_STORE_KEY), d.actorKey) } catch { restored = null }
        if (restored) {
          // This actor's own unfinished request. Its values are shown as sent; its real status is
          // confirmed by polling (if waiting) or by an explicit check. Nothing is re-sent here.
          setRecord(restored)
          showValues(form, restored.values)
          seededRef.current = true
        } else if (!seededRef.current) {
          form.applyIntervals(d.defaults.intervalMiles, d.defaults.intervalMonths)
          seededRef.current = true
        }
      })
      .catch((e) => {
        if (epoch !== epochRef.current) return
        setBooting(false)
        setLoadError(String((e as Error).message ?? e))
      })
    // Deliberately keyed on `open`: this is the open-the-dialog effect. The form setters it uses are
    // stable, and re-running it on each keystroke would refetch and overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ── Server conversation ────────────────────────────────────────────────────────────────────────
  const startPolling = useCallback((epoch: number, rec: QuickRequestRecord) => {
    stopPolling()
    if (epoch !== epochRef.current || !openRef.current) return
    pollRef.current = setInterval(async () => {
      if (epoch !== epochRef.current || !openRef.current) return
      try {
        const r = await fetch(`/api/oil-sticker/status?requestId=${encodeURIComponent(rec.requestId)}`)
        if (!r.ok) return // transient (or a 404 while the row commits) — the next tick retries
        const job: StickerJobView = await r.json()
        if (!commit(epoch, withJob(rec, job))) return
        if (!isWaitingStatus(job.status)) stopPolling()
      } catch { /* transient */ }
    }, 2500)
  }, [commit, stopPolling])

  // Resume polling for a restored request that is still on its way (never for a stale dialog).
  useEffect(() => {
    if (!open || booting || pollRef.current) return
    if (record?.state === 'tracked' && isWaitingStatus(record.job?.status)) startPolling(epochRef.current, record)
  }, [open, booting, record, startPolling])

  /** Send EXACTLY ONE request record. Persisted before dispatch; never mints a token itself. */
  const dispatchRequest = useCallback(async (rec: QuickRequestRecord) => {
    const epoch = epochRef.current
    setMsg(null)
    if (!commit(epoch, rec)) return // recorded BEFORE the network call, or not sent at all
    setBusy(true)
    try {
      const r = await fetch('/api/oil-sticker', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: rec.requestId, ...rec.values }),
      })
      const d = await r.json().catch(() => null)
      if (epoch !== epochRef.current) return
      if (r.ok && d?.job) {
        const next = withJob(rec, d.job)
        if (!commit(epoch, next)) return
        if (d.alreadyQueued) setMsg('That request had already been sent — this is its status, not a second sticker.')
        if (isWaitingStatus(d.job.status)) startPolling(epoch, next)
        return
      }
      const outcome = postFailureOutcome(r.status, d?.error)
      if (outcome === 'unauthorized') {
        // This attempt queued nothing — but it may be the RETRY of an earlier ambiguous one, so the
        // token is kept as unresolved. Hide the form (nothing is actionable while signed out);
        // signing in and reopening recovers the request and offers a status check of that token.
        commit(epoch, markUnknown(rec))
        setBoot(null)
        setLoadError('Sign in on this device to print a sticker, then open this window again.')
      } else if (outcome === 'conflict') {
        commit(epoch, null)
        setMsg(d?.message ?? 'That print request could not be used — tap print again.')
      } else if (outcome === 'not_dispatched') {
        commit(epoch, null) // refused before anything was written: fix the values and print again
        setMsg(d?.message ?? 'Nothing was sent — check the values and print again.')
      } else {
        commit(epoch, markUnknown(rec))
        setMsg('The shop server didn’t confirm this sticker. Check its status before sending anything else.')
      }
    } catch {
      if (epoch !== epochRef.current) return
      commit(epoch, markUnknown(rec))
      setMsg('The request may not have reached the shop. Check its status before sending anything else — don’t print a second sticker.')
    } finally {
      if (epoch === epochRef.current) setBusy(false)
    }
  }, [commit, startPolling])

  /** Ask the server what became of ONE token. The first move after any uncertain dispatch. */
  const resolveRequest = useCallback(async (rec: QuickRequestRecord) => {
    const epoch = epochRef.current
    setMsg(null)
    setBusy(true)
    try {
      const r = await fetch(`/api/oil-sticker/status?requestId=${encodeURIComponent(rec.requestId)}`)
      if (epoch !== epochRef.current) return
      if (r.status === 404) {
        // Not proof that nothing printed (the original POST may still be committing) — but
        // re-sending THIS token is safe, because the server can only ever accept it once.
        if (commit(epoch, markUnsent(rec))) setMsg('The shop has no record of this request. Sending the same request again is safe — it can only print once.')
        return
      }
      if (r.status === 401) { setMsg('Sign in on this device to print a sticker.'); return }
      if (!r.ok) { setMsg(UNREACHABLE); return }
      const job: StickerJobView = await r.json()
      const next = withJob(rec, job)
      if (!commit(epoch, next)) return
      if (isWaitingStatus(job.status)) startPolling(epoch, next)
    } catch {
      if (epoch === epochRef.current) setMsg(UNREACHABLE)
    } finally {
      if (epoch === epochRef.current) setBusy(false)
    }
  }, [commit, startPolling])

  // ── Actions ────────────────────────────────────────────────────────────────────────────────────
  const plan = planQuickAction({ record, canPrint: form.canPrint, busy, booting })

  const onPrimary = async () => {
    if (plan.disabled || busy || booting) return
    if (plan.kind === 'wait') return
    if (plan.kind === 'check' && record) { await resolveRequest(record); return }
    if (plan.kind === 'resend' && record) { await dispatchRequest(record); return }
    if (plan.kind === 'print') {
      if (!canMintNewRequest(record) || !boot) return // belt and braces: never duplicate a request
      const values = submittedValues(form)
      if (!values) return
      await dispatchRequest(beginRequest(boot.actorKey, mintRequestId(), values))
    }
  }

  /** Explicitly start over for the next vehicle. Only offered for a RESOLVED request, so it can
   *  never abandon one whose outcome is still unknown. */
  const startNew = () => {
    if (!plan.canStartNew || busy) return
    stopPolling()
    commit(epochRef.current, null)
    setMsg(null)
    form.setMileage('')
    form.resetOverrides()
  }

  const jobLine = stickerStatusLine(record?.state === 'tracked' ? record.job : null)
  const dispatchLine = record?.state === 'pending' || record?.state === 'unknown'
    ? 'This sticker was sent but the shop didn’t confirm it. Check its status — don’t print a second one.'
    : record?.state === 'unsent'
      ? 'Nothing is recorded for this request yet. Sending the same request again is safe — it can only print once.'
      : null
  const bridgeWarning = boot && !(boot.bridge.online && boot.bridge.labelPrinterConfigured)
    ? boot.bridge.online
      ? 'The shop computer has no label printer set up yet, so this sticker would fail instead of printing.'
      : 'The shop computer isn’t connected right now. A sticker sent now waits 10 minutes and then expires without printing.'
    : null
  const primaryLabel = busy ? (plan.kind === 'check' ? 'Checking…' : 'Sending…') : plan.label

  return (
    <>
      <style href="ps-oil-sticker-dialog" precedence="default">{DIALOG_CSS}</style>

      {/* Matches the homepage module rows (see ModuleRow in app/page.tsx) — same chrome, but this
          one opens a dialog instead of navigating, so it is a button, not a link. */}
      <button
        type="button"
        onClick={openDialog}
        className="group flex min-w-0 items-center gap-3 sm:gap-4 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3.5 text-left transition-colors hover:border-gray-700 hover:bg-gray-900/70 active:bg-gray-800"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-800 text-gray-300 transition-colors group-hover:bg-gray-700 group-hover:text-white">
          <StickerIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words font-semibold text-white">Print Oil Change Sticker</span>
          <span className="mt-1 block break-words text-xs leading-relaxed text-gray-400">Mileage in, sticker out — no job needed. Prints on the shop label printer.</span>
        </span>
        <svg className="shrink-0 text-gray-600 transition-colors group-hover:text-gray-400"
          width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>

      {/* Native modal: the browser owns focus containment, Esc/back dismissal, the top layer, and
          returning focus to the button. No role="dialog", no aria-modal, no focus trap. */}
      <dialog ref={dialogRef} aria-labelledby="quick-sticker-title" className="ps-sticker-dialog">
        {open && (
          <div className="ps-sticker-scroll px-5 pt-4 pb-10 sm:px-6 sm:pt-5">
            <div className="mb-1 flex items-start justify-between gap-3">
              <h2 id="quick-sticker-title" className="min-w-0 pt-2 text-xl font-bold text-white">Oil Change Sticker</h2>
              <button type="button" onClick={closeDialog} aria-label="Close"
                className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl leading-none text-gray-400 active:bg-gray-900">×</button>
            </div>
            <p className="mb-4 text-sm text-gray-500">Enter mileage, preview, and print at the shop.</p>

            {loadError && <p role="alert" className="mb-4 text-sm text-red-400">{loadError}</p>}
            {booting && !loadError && <p className="mb-4 text-sm text-gray-500">Loading…</p>}

            {boot && !booting && (
              <>
                <BridgeStatusLine bridge={boot.bridge} />

                <StickerFields form={form} idPrefix="quick-sticker" disabled={plan.fieldsLocked} autoFocus />

                {form.payload && <StickerPreviewCard payload={form.payload} />}

                <div aria-live="polite">
                  {jobLine && <p className={`${jobLine.tone} my-3 text-center text-sm`}>{jobLine.text}</p>}
                  {dispatchLine && <p className="my-2 text-center text-sm text-amber-300">{dispatchLine}</p>}
                  {msg && <p className="my-2 text-center text-sm text-amber-300">{msg}</p>}
                  {!jobLine && !dispatchLine && !msg && bridgeWarning && (
                    <p className="my-2 text-center text-sm text-amber-300">{bridgeWarning}</p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={onPrimary}
                  disabled={plan.disabled}
                  className="mt-2 min-h-[3.25rem] w-full rounded-2xl bg-amber-500 py-4 text-lg font-bold text-black transition-colors active:bg-amber-600 disabled:opacity-40"
                >
                  {primaryLabel}
                </button>

                {plan.canStartNew && (
                  <button type="button" onClick={startNew} disabled={busy}
                    className="mt-3 min-h-[3rem] w-full rounded-2xl border border-gray-700 py-3.5 text-base font-semibold text-gray-300 active:opacity-80 disabled:opacity-40">
                    Start a new sticker
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </dialog>
    </>
  )
}

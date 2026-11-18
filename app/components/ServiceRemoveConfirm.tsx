'use client'

import { useEffect, useId, useRef } from 'react'

/**
 * Removal confirmation for a single service line. Native <dialog> opened as a modal:
 * the browser provides top-layer rendering, focus containment, Escape handling, and
 * focus return — no role="dialog"/aria-modal/focus-trap re-implementation. Rendered
 * only while open (the parent unmounts it), so no closed-state display styling is
 * needed.
 *
 * BOTH buttons close the dialog natively via form method="dialog" BEFORE anything
 * runs: the browser returns focus to the invoker synchronously, and the close
 * handler then dispatches on returnValue ('remove' → onConfirm, anything else —
 * Cancel, Escape, back gesture — → onCancel). The mutation itself happens after the
 * close, in the parent; a failure keeps the row and surfaces the caller's error.
 */
export default function ServiceRemoveConfirm({ serviceName, consequence, busy = false, onCancel, onConfirm }: {
  serviceName: string
  /** Extra consequence line (e.g. parts/charges that go with the line). */
  consequence?: string
  /** The caller is mid-save elsewhere — hold the destructive action, keep Cancel free. */
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    const dlg = ref.current
    if (dlg && !dlg.open) {
      dlg.showModal()
      // React's autoFocus runs before the dialog is shown (when it can't take focus), so
      // place initial focus on the safe action explicitly once the modal is open.
      cancelRef.current?.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={(e) => {
        const dlg = e.currentTarget
        const choice = dlg.returnValue
        dlg.returnValue = ''   // Escape sets no value; reset so a stale 'remove' can't leak
        if (choice === 'remove') onConfirm()
        else onCancel()
      }}
      className="m-auto w-[min(92vw,24rem)] rounded-2xl border border-gray-700 bg-gray-900 p-0 text-white shadow-2xl [overscroll-behavior:contain] backdrop:bg-black/70 backdrop:overflow-hidden backdrop:[overscroll-behavior:contain]"
    >
      <div className="px-5 pt-5">
        <h2 id={titleId} className="text-lg font-bold leading-snug">Are you sure you want to remove this line?</h2>
        <div id={bodyId}>
          <p className="mt-2 text-base font-semibold break-words">{serviceName}</p>
          {consequence && <p className="mt-2 text-sm text-amber-300">{consequence}</p>}
        </div>
      </div>
      {/* method="dialog": both buttons close natively (focus returns to the invoker).
          Cancel is the first submit button, so a bare Enter is the safe default. */}
      <form method="dialog" className="flex gap-3 px-5 py-5">
        <button ref={cancelRef} value="cancel" autoFocus
          className="flex-1 min-h-11 rounded-2xl border border-gray-700 px-4 py-3 font-semibold text-gray-300 active:opacity-70">
          Cancel
        </button>
        <button value="remove" disabled={busy}
          className="flex-1 min-h-11 rounded-2xl bg-red-600 px-4 py-3 font-bold text-white active:bg-red-700 disabled:opacity-50">
          Remove
        </button>
      </form>
    </dialog>
  )
}

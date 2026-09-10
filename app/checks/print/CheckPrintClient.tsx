'use client'
/**
 * Renders one check on a US-Letter page with absolutely-positioned fields (inches → CSS at 96dpi) and
 * drives the browser's native print dialog to the Brother HL-L2420DW. A no-print toolbar (hidden in the
 * actual print) offers Print, and — for a REAL recorded check — records the print OUTCOME afterward
 * (printed / print failed) via /api/checks/[id]/print. Reprint of the SAME check reuses this page (the
 * QuickBooks txn + number never change; only reprintCount does). TEST PRINT shows a VOID watermark and
 * never calls any recording endpoint.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Field { key: string; value: string; xIn: number; yIn: number; widthIn: number; align: 'left' | 'right'; sizePt: number }
interface Props {
  pageWidthIn: number
  pageHeightIn: number
  fields: Field[]
  isTest: boolean
  checkId: string | null
  checkNumber: number | null
  printable: boolean
  alreadyPrinted: boolean
  calibration: { offsetX: number; offsetY: number; position: string }
}

export default function CheckPrintClient(props: Props) {
  const router = useRouter()
  const [printed, setPrinted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  function doPrint() {
    setPrinted(true)
    window.print()
  }

  async function recordOutcome(success: boolean, reprint = false) {
    if (!props.checkId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/checks/${props.checkId}/print`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success, reprint }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Could not save print status.')
      setNote(success ? 'Marked printed ✓' : 'Marked print failed — you can reprint the same check.')
      if (success) setTimeout(() => router.push('/checks'), 900)
    } catch (e) {
      setNote(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Screen-only toolbar */}
      <div className="no-print mx-auto max-w-md space-y-3 p-4">
        <div className="flex items-center justify-between">
          <button onClick={() => router.push('/checks')} className="text-sm text-neutral-500">← Back</button>
          <span className="text-xs text-neutral-400">pos {props.calibration.position} · off {props.calibration.offsetX}″,{props.calibration.offsetY}″</span>
        </div>

        {props.isTest ? (
          <div className="rounded-lg border border-dashed border-neutral-400 bg-neutral-50 p-3 text-sm text-neutral-600">
            <b>Test print.</b> Load PLAIN paper. Print, then hold it behind a blank check to check alignment. Nothing is recorded. Adjust offsets in Admin → Checks if fields are off.
          </div>
        ) : !props.printable ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">This check isn’t recorded in QuickBooks yet — it can’t be printed.</div>
        ) : (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">Check #{props.checkNumber} is recorded. Load the check stock, then print.</div>
        )}

        <button onClick={doPrint} disabled={!props.isTest && !props.printable} className="w-full rounded-xl bg-neutral-900 py-4 text-lg font-semibold text-white disabled:opacity-50">
          {props.isTest ? 'Print test page' : `Print check #${props.checkNumber}`}
        </button>

        {!props.isTest && printed && (
          <div className="space-y-2 rounded-xl border border-neutral-300 p-3">
            <p className="text-sm font-medium">Did it print correctly on the check?</p>
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => recordOutcome(true)} className="flex-1 rounded-lg bg-emerald-600 py-3 font-semibold text-white disabled:opacity-50">Printed OK</button>
              <button disabled={busy} onClick={() => recordOutcome(false)} className="flex-1 rounded-lg border border-red-300 py-3 font-semibold text-red-700 disabled:opacity-50">Print failed</button>
            </div>
            <button disabled={busy} onClick={() => { recordOutcome(true, true) }} className="w-full rounded-lg border border-neutral-300 py-2 text-sm">Log as reprint (same check #)</button>
            {note && <p className="text-center text-sm text-neutral-600">{note}</p>}
          </div>
        )}
      </div>

      {/* The printable check page */}
      <div className="check-page" style={{ width: `${props.pageWidthIn}in`, height: `${props.pageHeightIn}in` }}>
        {props.isTest && <div className="void-watermark">VOID — TEST — NOT NEGOTIABLE</div>}
        {props.fields.map((f) => (
          <div
            key={f.key}
            style={{
              position: 'absolute',
              left: `${f.xIn}in`,
              top: `${f.yIn}in`,
              width: `${f.widthIn}in`,
              textAlign: f.align,
              fontSize: `${f.sizePt}pt`,
              fontFamily: 'Georgia, "Times New Roman", serif',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {f.value}
          </div>
        ))}
      </div>

      <style>{`
        @media screen {
          .check-page { position: relative; margin: 12px auto; box-shadow: 0 0 0 1px #ddd; background: #fff; }
        }
        @media print {
          .no-print { display: none !important; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff; }
          .check-page { position: relative; margin: 0; }
          @page { size: letter; margin: 0; }
        }
        .void-watermark {
          position: absolute; top: 1.4in; left: 0; right: 0; text-align: center;
          font-size: 34pt; font-weight: 800; color: rgba(200,0,0,0.18);
          transform: rotate(-14deg); pointer-events: none; letter-spacing: 2px;
        }
      `}</style>
    </>
  )
}

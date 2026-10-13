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
interface TplText { value: string; xIn: number; yIn: number; sizePt: number; align: 'left' | 'right'; bold?: boolean; mode?: 'e13b' | 'placeholder' }
interface TplLine { x1In: number; y1In: number; x2In: number; y2In: number; widthPt?: number }
interface TplBox { xIn: number; yIn: number; wIn: number; hIn: number; widthPt?: number }
interface Template { texts: TplText[]; lines: TplLine[]; boxes: TplBox[]; micr?: (TplText & { mode: 'e13b' | 'placeholder' }) | null }
interface Props {
  pageWidthIn: number
  pageHeightIn: number
  fields: Field[]
  template: Template | null
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
      <div className="no-print mx-auto max-w-xl space-y-3 px-4 py-4 text-gray-200 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <button type="button" onClick={() => router.push('/checks')} className="flex min-h-11 items-center gap-1 text-sm text-gray-400 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"><span aria-hidden="true">←</span>Back</button>
          <span className="text-xs text-gray-400">pos {props.calibration.position} · off {props.calibration.offsetX}″,{props.calibration.offsetY}″</span>
        </div>

        {props.isTest ? (
          <div role="status" className="rounded-xl border border-sky-900/60 bg-sky-950/30 px-4 py-3 text-sm/relaxed text-sky-200">
            <b>Test print.</b> Load PLAIN paper. Print, then hold it behind a blank check to check alignment. Nothing is recorded. Adjust offsets in Admin → Checks if fields are off.
          </div>
        ) : !props.printable ? (
          <div role="alert" className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm/relaxed text-red-200">This check isn’t recorded in QuickBooks yet — it can’t be printed.</div>
        ) : (
          <div role="status" className="rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm/relaxed text-emerald-200">Check #{props.checkNumber} is recorded. Load the check stock, then print.</div>
        )}

        <button type="button" onClick={doPrint} disabled={!props.isTest && !props.printable} className="flex min-h-14 w-full items-center justify-center rounded-xl bg-blue-600 px-5 py-3 text-center text-base font-semibold text-white transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
          {props.isTest ? 'Print test page' : `Print check #${props.checkNumber}`}
        </button>

        {!props.isTest && printed && (
          <div className="space-y-3 rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <p className="text-sm font-medium text-white">Did it print correctly on the check?</p>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => recordOutcome(true)} className="min-h-12 flex-1 rounded-xl bg-emerald-600 px-3 py-2 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">Printed OK</button>
              <button type="button" disabled={busy} onClick={() => recordOutcome(false)} className="min-h-12 flex-1 rounded-xl border border-red-900/60 bg-red-950/30 px-3 py-2 font-semibold text-red-300 transition-colors hover:border-red-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">Print failed</button>
            </div>
            <button type="button" disabled={busy} onClick={() => { recordOutcome(true, true) }} className="flex min-h-11 w-full items-center justify-center rounded-xl border border-gray-700 px-4 py-2 text-center text-sm font-semibold text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800/60 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">Log as reprint (same check #)</button>
            {note && <p role="status" className="text-center text-sm text-gray-300 [overflow-wrap:anywhere]">{note}</p>}
          </div>
        )}
      </div>

      {/* The printable check page */}
      <div className="check-page" style={{ width: `${props.pageWidthIn}in`, height: `${props.pageHeightIn}in` }}>
        {props.isTest && <div className="void-watermark">VOID — TEST — NOT NEGOTIABLE</div>}

        {/* Blank-stock face template: boxes, lines, labels, MICR band */}
        {props.template?.boxes.map((b, i) => (
          <div key={`box${i}`} style={{ position: 'absolute', left: `${b.xIn}in`, top: `${b.yIn}in`, width: `${b.wIn}in`, height: `${b.hIn}in`, border: `${b.widthPt ?? 1}px solid #111` }} />
        ))}
        {props.template?.lines.map((l, i) => (
          <div key={`ln${i}`} style={{ position: 'absolute', left: `${Math.min(l.x1In, l.x2In)}in`, top: `${Math.min(l.y1In, l.y2In)}in`, width: `${Math.abs(l.x2In - l.x1In)}in`, height: 0, borderTop: `${l.widthPt ?? 0.75}px solid #111` }} />
        ))}
        {props.template?.texts.map((t, i) => (
          <div key={`tt${i}`} style={{ position: 'absolute', left: `${t.xIn}in`, top: `${t.yIn}in`, width: '3in', textAlign: t.align, fontSize: `${t.sizePt}pt`, fontWeight: t.bold ? 700 : 400, fontFamily: 'Georgia, "Times New Roman", serif', whiteSpace: 'nowrap' }}>{t.value}</div>
        ))}
        {props.template?.micr && (
          <div style={{ position: 'absolute', left: 0, width: `${props.template.micr.xIn}in`, textAlign: 'right', top: `${props.template.micr.yIn - 0.12}in`, fontSize: '8pt', letterSpacing: '2px', fontFamily: 'monospace', color: '#b00', whiteSpace: 'nowrap' }}>
            {/* Browser preview only: the real E-13B line is embedded by the shop-printer PDF, never here. */}
            {props.template.micr.mode === 'e13b' ? 'MICR LINE (E-13B) PRINTS HERE ON THE SHOP PRINTER' : props.template.micr.value}
          </div>
        )}

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

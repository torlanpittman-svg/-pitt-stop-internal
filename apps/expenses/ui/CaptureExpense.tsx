'use client'
/**
 * Business Receipts — employee capture. Snap a photo (rear camera preferred) or upload one → it uploads,
 * AI reads it, and it lands in the manager REVIEW queue. Employees never see accounting jargon here — no
 * category/entity/approval. Progress, success and failure states are explicit; a double-submit is guarded
 * (the button disables while busy and the file input resets after each send).
 */
import { useRef, useState } from 'react'

type Phase = 'idle' | 'preview' | 'uploading' | 'done' | 'error'
type Dup = { when: string; status: string } | null

export default function CaptureExpense() {
  const camRef = useRef<HTMLInputElement>(null)
  const upRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dup, setDup] = useState<Dup>(null)
  const [aiOk, setAiOk] = useState(true)

  function pick(f: File | null) {
    if (!f) return
    setFile(f); setErr(null); setDup(null)
    setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(f) })
    setPhase('preview')
  }
  function reset() {
    setFile(null); setErr(null); setDup(null); setAiOk(true)
    if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null)
    if (camRef.current) camRef.current.value = ''
    if (upRef.current) upRef.current.value = ''
    setPhase('idle')
  }

  async function submit() {
    if (!file || phase === 'uploading') return // double-submit guard
    setPhase('uploading'); setErr(null)
    try {
      const fd = new FormData(); fd.set('receipt', file)
      const res = await fetch('/api/expenses/receipt', { method: 'POST', body: fd })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) { setErr(j.error || 'Could not send — try again.'); setPhase('error'); return }
      setAiOk(j.aiStatus === 'extracted')
      setDup(j.duplicateWarning ? { when: String(j.duplicateWarning.when).slice(0, 10), status: j.duplicateWarning.status } : null)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPhase('done')
    } catch { setErr('No connection — try again in a moment.'); setPhase('error') }
  }

  return (
    <section className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
      <div className="px-4 py-4">
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <input ref={upRef} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />

        {phase === 'idle' && (
          <div className="space-y-3">
            <button type="button" onClick={() => camRef.current?.click()} className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-lg font-bold py-5 rounded-2xl">📷 Snap a Receipt</button>
            <button type="button" onClick={() => upRef.current?.click()} className="w-full border border-gray-700 text-gray-200 text-base font-semibold py-3 rounded-2xl">Upload a Photo</button>
          </div>
        )}

        {phase === 'preview' && (
          <div className="space-y-3">
            {previewUrl && <img src={previewUrl} alt="receipt" className="w-full rounded-xl max-h-96 object-contain bg-black/40" />}
            <button type="button" onClick={submit} className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl">Send Receipt</button>
            <button type="button" onClick={reset} className="w-full text-gray-400 py-2">Retake / cancel</button>
          </div>
        )}

        {phase === 'uploading' && <div className="py-10 text-center text-gray-400">Sending &amp; reading receipt…</div>}

        {phase === 'done' && (
          <div className="space-y-3 py-2 text-center">
            <div className="text-4xl">✅</div>
            <p className="text-white font-semibold">Receipt sent to review.</p>
            {!aiOk && <p className="text-amber-400 text-sm">We couldn’t read it automatically — a manager will fill in the details.</p>}
            {dup && <p className="text-amber-300 text-sm rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2">⚠ Looks like one already captured on {dup.when} ({dup.status.replace('_', ' ')}). It’s saved again — a manager will sort out any duplicate.</p>}
            <button type="button" onClick={reset} className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-base font-bold py-4 rounded-2xl">Capture Another</button>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            {previewUrl && <img src={previewUrl} alt="receipt" className="w-full rounded-xl max-h-72 object-contain bg-black/40" />}
            <p className="text-red-400 text-sm">{err}</p>
            <button type="button" onClick={submit} className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl">Try Again</button>
            <button type="button" onClick={reset} className="w-full text-gray-400 py-2">Cancel</button>
          </div>
        )}
      </div>
    </section>
  )
}

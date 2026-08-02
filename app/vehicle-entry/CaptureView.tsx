'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import GuidedCamera from './GuidedCamera'
import PhotoInput from '@/app/components/PhotoInput'

type State = 'idle' | 'scanning' | 'error'

export default function CaptureView({
  isDemoMode,
  isPilotMode = false,
}: {
  isDemoMode: boolean
  isPilotMode?: boolean
}) {
  const router = useRouter()
  const [state,    setState]    = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Called by GuidedCamera with either:
  //   camera capture  → primary = cropped frame, original = full frame
  //   file upload     → primary = uploaded file,  original = null
  const doOCR = useCallback(async (primary: File, original: File | null) => {
    setState('scanning')
    setErrorMsg(null)

    const fd = new FormData()
    fd.append('image', primary, primary.name)
    if (original) fd.append('originalImage', original, original.name)

    let res: Response
    try {
      res = await fetch('/api/vehicle-entry/ocr', { method: 'POST', body: fd })
    } catch (err) {
      setErrorMsg(`Network error — ${String(err)}`)
      setState('error')
      return
    }

    const data = await res.json().catch(() => ({}) as Record<string, unknown>) as Record<string, unknown>
    if (!res.ok) {
      setErrorMsg((data.error as string) ?? `OCR failed (HTTP ${res.status})`)
      setState('error')
      return
    }

    router.push(`/vehicle-entry/confirm/${data.id as string}`)
  }, [router])

  const handleManualEntry = useCallback(async () => {
    setState('scanning')
    setErrorMsg(null)
    try {
      const res  = await fetch('/api/vehicle-entry/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error((data.error as string) ?? 'Failed')
      router.push(`/vehicle-entry/confirm/${data.id as string}?mode=manual`)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [router])

  // ── Scanning state ─────────────────────────────────────────────────────────
  if (state === 'scanning') {
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400 text-sm">
          {isDemoMode ? 'Mock AI reading tag…' : 'AI reading handwritten tag…'}
        </p>
      </main>
    )
  }

  return (
    <main className="h-[100dvh] bg-black flex flex-col">

      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
        <a href="/vehicle-entry" className="text-gray-500 text-sm">← Back</a>
        <span className="text-white font-semibold">Scan Key Tag</span>
        <div className="w-10" />
      </div>

      {/* Banners */}
      {isPilotMode && (
        <div className="mx-4 mb-2 bg-yellow-950 border border-yellow-800 rounded-xl px-4 py-1.5 text-yellow-300 text-xs shrink-0 text-center font-medium">
          TEST MODE — Mock QuickBooks Active
        </div>
      )}
      {isDemoMode && (
        <div className="mx-4 mb-2 bg-yellow-950 border border-yellow-800 rounded-xl px-4 py-1.5 text-yellow-300 text-xs shrink-0">
          Demo mode — mock OCR active (no AI)
        </div>
      )}
      {errorMsg && (
        <div className="mx-4 mb-2 bg-red-950 border border-red-800 rounded-xl px-4 py-3 shrink-0">
          <p className="text-red-300 text-sm font-semibold mb-1">Scan failed</p>
          <p className="text-red-400 text-xs">{errorMsg}</p>
          <button
            onClick={() => { setState('idle'); setErrorMsg(null) }}
            className="mt-2 text-xs text-red-400 underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Camera / upload — GuidedCamera (specialized live capture) hosted inside
          the shared PhotoInput, which owns the standardized upload path.
          normalize={false} keeps the key-tag OCR input byte-for-byte as before. */}
      <PhotoInput
        live
        normalize={false}
        uploadLabel="Upload existing photo"
        renderCamera={({ deliver }) => <GuidedCamera onCapture={(primary, original) => deliver(primary, original)} />}
        onCapture={doOCR}
      />

      {/* Fallback options */}
      <div className="bg-black shrink-0 border-t border-gray-900 flex flex-col items-center gap-1 pt-2 pb-3 pb-safe">
        <a
          href="/vehicle-entry/vin"
          className="text-gray-400 text-sm py-1"
        >
          Tag unreadable? Scan VIN instead →
        </a>
        <button
          onClick={handleManualEntry}
          className="text-gray-600 text-xs underline py-1"
        >
          Enter manually
        </button>
      </div>

    </main>
  )
}

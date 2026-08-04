'use client'

/**
 * PhotoInput — the ONE standard image-entry component for all of Pitt Stop OS.
 *
 * Two modes, one contract (`onCapture(primary, original)`):
 *
 * 1. Default (simple): 📷 Take Photo + 🖼 Upload Photo buttons. Both run the same
 *    client pipeline — validate → EXIF-orientation correct → downscale → JPEG
 *    compress (dependency-free canvas) — then preview with Replace / Remove before
 *    handing the parent a normalized File. `original` is always null here.
 *
 * 2. Live composition (`live` + `renderCamera`): a feature's SPECIALIZED live
 *    camera (portrait guide, quality feedback, crop-to-frame, dual crop+original
 *    output) is rendered immediately and plugs in via `deliver()`. A shared
 *    "Upload existing photo instead" affordance provides the standard upload path.
 *    The specialized camera's exact behavior and compression are preserved (set
 *    `normalize={false}` to pass OCR inputs through untouched).
 *
 * Either way the image SOURCE (camera vs library) is invisible downstream, so a
 * feature's OCR / Blob upload / storage / audit runs identically. No OCR
 * confidence, technical warnings, or storage details are ever shown here.
 */
import { useCallback, useRef, useState, useEffect } from 'react'
import { isAcceptedMimeType } from '@/platform/image'

interface PhotoInputProps {
  /** Called with the confirmed image. `original` is the full frame (specialized
   *  cameras) or null (uploads / simple capture). */
  onCapture: (primary: File, original: File | null) => void
  onRemove?: () => void
  /** Primary button label on the preview (e.g. "Scan VIN", "Use Photo"). */
  continueLabel?: string
  /** Parent is processing (e.g. running OCR) — disables the controls. */
  busy?: boolean
  className?: string
  /** Client normalization of the upload/simple-capture path (default on). Set
   *  false to pass the raw file through unchanged (OCR-critical inputs). */
  normalize?: boolean
  maxDimension?: number
  quality?: number
  /** Live composition: render a specialized camera immediately; it reports via
   *  deliver(primary, original?). When set, the two-button gate is skipped. */
  renderCamera?: (api: { deliver: (primary: File, original?: File | null) => void }) => React.ReactNode
  live?: boolean
  /** Upload-only: just the shared Upload affordance (for screens whose camera is
   *  a specialized non-file capture, e.g. a live barcode scanner). */
  uploadOnly?: boolean
  /** Two-button entry, but deliver onCapture IMMEDIATELY on selection (no
   *  preview/continue step) — e.g. VIN scan that auto-runs OCR after Take/Upload. */
  immediate?: boolean
  /** Label for the shared upload affordance in live / upload-only mode. */
  uploadLabel?: string
}

async function normalizeImage(file: File, maxDimension: number, quality: number): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
    if (!blob) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export default function PhotoInput({
  onCapture, onRemove, continueLabel = 'Use Photo', busy = false, className = '',
  normalize = true, maxDimension = 1600, quality = 0.85,
  renderCamera, live = false, uploadOnly = false, immediate = false, uploadLabel = 'Upload existing photo instead',
}: PhotoInputProps) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<{ url: string; file: File } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])

  const validate = (file: File): boolean => {
    const type = file.type || ''
    if (type && !isAcceptedMimeType(type) && !type.startsWith('image/')) { setError('Please choose an image file.'); return false }
    return true
  }
  const prepare = async (file: File): Promise<File> => (normalize ? normalizeImage(file, maxDimension, quality) : file)

  // Live mode: upload affordance delivers immediately (matches specialized cameras).
  const uploadDeliver = useCallback(async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!validate(file)) return
    setWorking(true)
    try { onCapture(await prepare(file), null) } finally { setWorking(false) }
  }, [onCapture, normalize, maxDimension, quality])

  // Simple mode: selection → normalize → preview (confirm before onCapture).
  // Immediate mode: selection → normalize → onCapture right away (no confirm step).
  const pickForPreview = useCallback(async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!validate(file)) return
    setWorking(true)
    try {
      const out = await prepare(file)
      if (immediate) { onCapture(out, null); return }
      setPreview((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { url: URL.createObjectURL(out), file: out } })
    } finally { setWorking(false) }
  }, [normalize, maxDimension, quality, immediate, onCapture])

  const clear = useCallback((notify: boolean) => {
    setPreview((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null })
    setError(null)
    if (notify) onRemove?.()
  }, [onRemove])

  const hiddenInput = (ref: React.RefObject<HTMLInputElement | null>, camera: boolean, onFile: (f: File | undefined) => void) => (
    <input ref={ref} type="file" accept="image/*" {...(camera ? { capture: 'environment' as const } : {})}
      hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f) }} />
  )

  // ── Upload-only mode: just the shared upload affordance ────────────────────
  if (uploadOnly) {
    const locked = busy || working
    return (
      <div className={`w-full ${className}`}>
        <div className={`relative w-full ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
          <div className="w-full rounded-2xl bg-blue-600 text-white text-lg font-bold py-4 text-center pointer-events-none select-none">
            🖼 {working ? 'Preparing photo…' : uploadLabel}
          </div>
          <input ref={libraryRef} type="file" accept="image/*" disabled={locked}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void uploadDeliver(f) }}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
        </div>
        {error && <p className="text-amber-400 text-sm text-center mt-2">{error}</p>}
      </div>
    )
  }

  // ── Live composition mode: specialized camera + shared upload ──────────────
  if (live && renderCamera) {
    return (
      <div className={`flex flex-col flex-1 min-h-0 ${className}`}>
        {renderCamera({ deliver: (primary, original = null) => onCapture(primary, original) })}
        <div className="bg-black shrink-0 flex flex-col items-center gap-2 pt-3 pb-4 px-6">
          {error && <p className="text-amber-400 text-xs text-center">{error}</p>}
          {/* Shared upload path — prominent so it works on desktop / when the
              camera is unavailable. Uploads deliver immediately (no re-compression
              when normalize=false) to match the camera pipeline exactly. */}
          <div className={`relative w-full ${busy || working ? 'opacity-60 pointer-events-none' : ''}`}>
            <div className="w-full rounded-2xl border-2 border-gray-700 text-white text-base font-semibold py-3.5 text-center pointer-events-none select-none">
              🖼 {working ? 'Preparing photo…' : uploadLabel}
            </div>
            <input ref={libraryRef} type="file" accept="image/*" disabled={busy || working}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void uploadDeliver(f) }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
          </div>
        </div>
      </div>
    )
  }

  // ── Default: empty two-button entry ────────────────────────────────────────
  if (!preview) {
    return (
      <div className={`space-y-3 ${className}`}>
        {hiddenInput(cameraRef, true, pickForPreview)}
        {hiddenInput(libraryRef, false, pickForPreview)}
        {error && <p className="text-amber-400 text-sm text-center">{error}</p>}
        <button type="button" disabled={busy || working} onClick={() => cameraRef.current?.click()}
          className="w-full h-16 rounded-2xl bg-white text-black text-lg font-bold disabled:opacity-50">📷 Take Photo</button>
        <button type="button" disabled={busy || working} onClick={() => libraryRef.current?.click()}
          className="w-full h-16 rounded-2xl border-2 border-gray-700 text-white text-lg font-bold disabled:opacity-50">🖼 Upload Photo</button>
        {working && <p className="text-gray-400 text-sm text-center">Preparing photo…</p>}
      </div>
    )
  }

  // ── Default: preview + Replace / Remove + continue ─────────────────────────
  return (
    <div className={`space-y-3 ${className}`}>
      {hiddenInput(cameraRef, true, pickForPreview)}
      {hiddenInput(libraryRef, false, pickForPreview)}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={preview.url} alt="Selected photo" className="w-full max-h-72 object-contain rounded-2xl bg-gray-900 border border-gray-800" />
      {error && <p className="text-amber-400 text-sm text-center">{error}</p>}
      <button type="button" disabled={busy || working} onClick={() => onCapture(preview.file, null)}
        className="w-full h-16 rounded-2xl bg-blue-600 active:bg-blue-700 text-white text-lg font-bold disabled:opacity-50">
        {busy ? 'Working…' : continueLabel}
      </button>
      <div className="flex gap-3">
        <button type="button" disabled={busy || working} onClick={() => clear(false)}
          className="flex-1 h-12 rounded-2xl border border-gray-700 text-gray-300 disabled:opacity-50">Replace Photo</button>
        <button type="button" disabled={busy || working} onClick={() => clear(true)}
          className="flex-1 h-12 rounded-2xl border border-gray-700 text-gray-400 disabled:opacity-50">Remove Photo</button>
      </div>
    </div>
  )
}

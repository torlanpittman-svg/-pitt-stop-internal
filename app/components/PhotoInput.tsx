'use client'

/**
 * PhotoInput — the ONE standard image-entry component for all of Pitt Stop OS.
 *
 * Every feature that accepts an image uses this. It offers both entry paths —
 * 📷 Take Photo (camera) and 🖼 Upload Photo (library) — and funnels BOTH through
 * the exact same client pipeline: validation → orientation correction + downscale
 * + compression (dependency-free canvas), then hands the parent a single
 * normalized File via onImage(). The source (camera vs library) is invisible to
 * everything downstream, so a feature's OCR / Blob upload / storage / audit runs
 * identically regardless of where the image came from.
 *
 * UX: after a photo is chosen it is previewed with Replace Photo / Remove Photo,
 * then a primary action (continueLabel) hands the image to the parent workflow.
 * No OCR confidence, technical warnings, or storage details are ever shown here.
 */
import { useCallback, useRef, useState, useEffect } from 'react'
import { isAcceptedMimeType } from '@/platform/image'

interface PhotoInputProps {
  /** Called with the normalized image when the operator confirms the photo. */
  onImage: (file: File) => void
  /** Optional: called when the operator removes the chosen photo. */
  onRemove?: () => void
  /** Primary button label shown on the preview (e.g. "Scan VIN", "Use Photo"). */
  continueLabel?: string
  /** Parent is processing (e.g. running OCR) — disables the controls. */
  busy?: boolean
  className?: string
}

const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.85

/**
 * Orientation-correct, downscale, and compress — dependency-free. Uses
 * createImageBitmap with imageOrientation:'from-image' so EXIF-rotated phone
 * photos come out upright. Falls back to the original file if the browser can't
 * process it, so a valid image is never blocked.
 */
async function normalize(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY))
    if (!blob) return file
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export default function PhotoInput({ onImage, onRemove, continueLabel = 'Use Photo', busy = false, className = '' }: PhotoInputProps) {
  const cameraRef = useRef<HTMLInputElement>(null)   // capture=environment → camera
  const libraryRef = useRef<HTMLInputElement>(null)  // no capture → photo library
  const [preview, setPreview] = useState<{ url: string; file: File } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])

  const pick = useCallback(async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const type = file.type || ''
    if (type && !isAcceptedMimeType(type) && !type.startsWith('image/')) {
      setError('Please choose an image file.'); return
    }
    setWorking(true)
    try {
      const normalized = await normalize(file)
      setPreview((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { url: URL.createObjectURL(normalized), file: normalized } })
    } finally { setWorking(false) }
  }, [])

  const clear = useCallback((notify: boolean) => {
    setPreview((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null })
    setError(null)
    if (notify) onRemove?.()
  }, [onRemove])

  const hiddenInput = (ref: React.RefObject<HTMLInputElement | null>, camera: boolean) => (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      {...(camera ? { capture: 'environment' as const } : {})}
      hidden
      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pick(f) }}
    />
  )

  // ── Empty: the two standard entry actions ──────────────────────────────────
  if (!preview) {
    return (
      <div className={`space-y-3 ${className}`}>
        {hiddenInput(cameraRef, true)}
        {hiddenInput(libraryRef, false)}
        {error && <p className="text-amber-400 text-sm text-center">{error}</p>}
        <button type="button" disabled={busy || working} onClick={() => cameraRef.current?.click()}
          className="w-full h-16 rounded-2xl bg-white text-black text-lg font-bold disabled:opacity-50">
          📷 Take Photo
        </button>
        <button type="button" disabled={busy || working} onClick={() => libraryRef.current?.click()}
          className="w-full h-16 rounded-2xl border-2 border-gray-700 text-white text-lg font-bold disabled:opacity-50">
          🖼 Upload Photo
        </button>
        {working && <p className="text-gray-400 text-sm text-center">Preparing photo…</p>}
      </div>
    )
  }

  // ── Preview: preview + Replace / Remove + continue ─────────────────────────
  return (
    <div className={`space-y-3 ${className}`}>
      {hiddenInput(cameraRef, true)}
      {hiddenInput(libraryRef, false)}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={preview.url} alt="Selected photo" className="w-full max-h-72 object-contain rounded-2xl bg-gray-900 border border-gray-800" />
      {error && <p className="text-amber-400 text-sm text-center">{error}</p>}
      <button type="button" disabled={busy || working} onClick={() => onImage(preview.file)}
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

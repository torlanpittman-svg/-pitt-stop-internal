'use client'

import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import EstimatorCamera from '@/app/estimator/EstimatorCamera'

const PHOTO_STEPS = [
  { role: 'driver_side',    label: 'Driver Side',      hint: 'Step back — capture the full left side of the vehicle' },
  { role: 'passenger_side', label: 'Passenger Side',   hint: 'Step back — capture the full right side of the vehicle' },
  { role: 'front',          label: 'Front',             hint: 'Straight-on view of the front bumper and grille' },
  { role: 'rear',           label: 'Rear',              hint: 'Straight-on view of the rear bumper and taillights' },
  { role: 'interior_front', label: 'Front Interior',   hint: 'Open the driver door — photograph seats, dash, and console' },
  { role: 'interior_rear',  label: 'Rear Seats',       hint: 'Photograph the rear seat area and floor' },
  { role: 'interior_floor', label: 'Floor & Carpet',   hint: 'Capture the carpet, floor mats, and foot wells' },
  { role: 'trunk',          label: 'Trunk / Cargo',    hint: 'Open the trunk or tailgate and photograph inside' },
]

type UploadedPhoto = {
  role:     string
  photoUrl: string
  step:     number
}

export default function PhotoCapture({ estimateId }: { estimateId: string }) {
  const router = useRouter()

  const [step,      setStep]      = useState(0)
  const [photos,    setPhotos]    = useState<UploadedPhoto[]>([])
  const [uploading, setUploading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const keyRef = useRef(0)  // forces camera remount on step advance

  const currentStep = PHOTO_STEPS[step]
  const isLastStep  = step === PHOTO_STEPS.length - 1

  const handleCapture = useCallback(async (file: File) => {
    setUploading(true)
    setError(null)

    try {
      const fd = new FormData()
      fd.append('image', file, file.name)
      fd.append('role', currentStep.role)
      fd.append('captureOrder', String(step))

      const res = await fetch(`/api/estimator/estimates/${estimateId}/photos`, {
        method: 'POST',
        body:   fd,
      })
      const data = await res.json() as { photoUrl?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')

      const uploaded: UploadedPhoto = {
        role:     currentStep.role,
        photoUrl: data.photoUrl!,
        step,
      }

      setPhotos(prev => [...prev, uploaded])

      if (isLastStep) {
        router.push(`/estimator/${estimateId}/photo-review`)
      } else {
        keyRef.current += 1
        setStep(s => s + 1)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }, [currentStep, step, estimateId, isLastStep, router])

  const handleSkip = useCallback(() => {
    if (isLastStep) {
      if (photos.length === 0) return  // must have at least one photo
      router.push(`/estimator/${estimateId}/photo-review`)
    } else {
      keyRef.current += 1
      setStep(s => s + 1)
    }
  }, [isLastStep, photos.length, estimateId, router])

  return (
    <main className="h-[100dvh] bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-2 shrink-0 bg-black">
        <button
          onClick={() => {
            if (step === 0) {
              router.push(`/estimator/${estimateId}/vehicle`)
            } else {
              keyRef.current += 1
              setStep(s => s - 1)
            }
          }}
          className="text-gray-500 text-sm"
        >
          ← Back
        </button>

        <div className="text-center">
          <p className="text-white font-semibold text-sm">{currentStep.label}</p>
          <p className="text-gray-500 text-xs">{step + 1} of {PHOTO_STEPS.length}</p>
        </div>

        <button
          onClick={handleSkip}
          className="text-gray-600 text-sm"
        >
          Skip
        </button>
      </div>

      {/* Progress bar */}
      <div className="flex gap-1 px-5 pb-2 shrink-0 bg-black">
        {PHOTO_STEPS.map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < step ? 'bg-blue-500' :
              i === step ? 'bg-white' :
              'bg-gray-800'
            }`}
          />
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mb-2 bg-red-950 border border-red-800 rounded-xl px-4 py-3 shrink-0">
          <p className="text-red-300 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-red-500 text-xs underline mt-1">
            Try again
          </button>
        </div>
      )}

      {/* Upload overlay */}
      {uploading && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center z-10 gap-3">
          <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-white text-sm">Uploading…</p>
        </div>
      )}

      {/* Camera — re-mounts on step change via key */}
      <EstimatorCamera
        key={keyRef.current}
        stepLabel={currentStep.label}
        stepHint={currentStep.hint}
        onCapture={handleCapture}
      />

      {/* Thumbnail strip */}
      {photos.length > 0 && (
        <div className="absolute top-[72px] right-3 flex flex-col gap-1.5 z-10">
          {photos.slice(-4).map((p, i) => (
            <div key={i} className="w-10 h-10 rounded-lg overflow-hidden border border-white/20 bg-gray-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.photoUrl} alt={p.role} className="w-full h-full object-cover" />
            </div>
          ))}
        </div>
      )}
    </main>
  )
}

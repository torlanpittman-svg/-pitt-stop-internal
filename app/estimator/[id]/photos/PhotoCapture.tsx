'use client'

import { useState, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import EstimatorCamera from '@/app/estimator/EstimatorCamera'
import { buildPhotoSteps } from '@/apps/estimator/photo-steps'
import { applyLayoutAnswers } from '@/apps/estimator/vehicle-layout'
import type { LayoutInference, LayoutQuestion } from '@/apps/estimator/vehicle-layout'

type UploadedPhoto = {
  role:     string
  photoUrl: string
  step:     number
}

export default function PhotoCapture({
  estimateId,
  serviceFocus,
  layoutInference,
}: {
  estimateId:      string
  serviceFocus:    string | null
  layoutInference: LayoutInference
}) {
  const router = useRouter()

  // Answers collected from the clarification question screen
  const [answers, setAnswers] = useState<Partial<Record<LayoutQuestion['key'], boolean>>>({})

  // Questions still pending (preserves original order)
  const pendingQuestions = layoutInference.questions.filter(q => !(q.key in answers))
  const needsQuestions   = pendingQuestions.length > 0

  // Resolved layout and photo steps — recomputed whenever answers change
  const layout = useMemo(
    () => applyLayoutAnswers(layoutInference.layout, answers),
    [layoutInference.layout, answers]
  )
  const steps = useMemo(
    () => needsQuestions ? [] : buildPhotoSteps(layout, serviceFocus),
    [needsQuestions, layout, serviceFocus]
  )

  // Camera / upload state
  const [step,      setStep]      = useState(0)
  const [photos,    setPhotos]    = useState<UploadedPhoto[]>([])
  const [uploading, setUploading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const keyRef = useRef(0)

  const currentStep = steps[step]
  const isLastStep  = step === steps.length - 1

  const handleAnswer = useCallback((key: LayoutQuestion['key'], value: boolean) => {
    setAnswers(prev => ({ ...prev, [key]: value }))
  }, [])

  const advance = useCallback(() => {
    if (isLastStep) {
      if (photos.length === 0) return
      router.push(`/estimator/${estimateId}/photo-review`)
    } else {
      keyRef.current += 1
      setStep(s => s + 1)
    }
  }, [isLastStep, photos.length, estimateId, router])

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

      setPhotos(prev => [...prev, { role: currentStep.role, photoUrl: data.photoUrl!, step }])
      advance()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }, [currentStep, step, estimateId, advance])

  const handleSkipOrNA = useCallback(() => advance(), [advance])

  // ── QUESTION SCREEN ────────────────────────────────────────────────────────
  if (needsQuestions) {
    const q      = pendingQuestions[0]
    const qIndex = layoutInference.questions.indexOf(q)
    const qTotal = layoutInference.questions.length

    return (
      <main className="h-[100dvh] bg-gray-950 flex flex-col">
        <div className="flex items-center justify-between px-5 pt-6 pb-4 shrink-0">
          <button
            onClick={() => {
              if (qIndex === 0) {
                router.push(`/estimator/${estimateId}/vehicle`)
              } else {
                const prevQ = layoutInference.questions[qIndex - 1]
                setAnswers(prev => {
                  const next = { ...prev }
                  delete next[prevQ.key]
                  return next
                })
              }
            }}
            className="text-gray-500 text-sm"
          >
            ← Back
          </button>
          <span className="text-gray-400 text-sm">Before We Start</span>
          <div className="w-16" />
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-8 gap-8">
          {qTotal > 1 && (
            <p className="text-gray-600 text-xs uppercase tracking-widest">
              Question {qIndex + 1} of {qTotal}
            </p>
          )}
          <p className="text-white text-xl font-bold text-center leading-snug">
            {q.text}
          </p>
          <div className="flex gap-4 w-full max-w-xs">
            <button
              onClick={() => handleAnswer(q.key, true)}
              className="flex-1 py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-bold text-lg transition-colors"
            >
              Yes
            </button>
            <button
              onClick={() => handleAnswer(q.key, false)}
              className="flex-1 py-4 rounded-2xl bg-gray-800 hover:bg-gray-700 active:bg-gray-900 text-white font-bold text-lg transition-colors"
            >
              No
            </button>
          </div>
          <p className="text-gray-600 text-xs text-center">
            This determines which photos to collect
          </p>
        </div>
      </main>
    )
  }

  if (!currentStep) return null

  // ── CAMERA FLOW ────────────────────────────────────────────────────────────
  return (
    <main className="h-[100dvh] bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-2 shrink-0 bg-black">
        <button
          onClick={() => {
            if (step === 0) {
              if (layoutInference.questions.length > 0) {
                // Un-answer the last question to return to the question screen
                const lastQ = layoutInference.questions[layoutInference.questions.length - 1]
                setAnswers(prev => {
                  const next = { ...prev }
                  delete next[lastQ.key]
                  return next
                })
              } else {
                router.push(`/estimator/${estimateId}/vehicle`)
              }
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
          <div className="flex items-center justify-center gap-1.5">
            <p className="text-white font-semibold text-sm">{currentStep.label}</p>
            {currentStep.bonus && (
              <span className="text-xs bg-amber-900/60 text-amber-400 rounded-full px-1.5 py-0.5 leading-none">
                Optional
              </span>
            )}
          </div>
          <p className="text-gray-500 text-xs">{step + 1} of {steps.length}</p>
        </div>

        <button
          onClick={handleSkipOrNA}
          className={`text-sm font-medium ${currentStep.bonus ? 'text-gray-300' : 'text-gray-600'}`}
        >
          Skip
        </button>
      </div>

      {/* Progress bar */}
      <div className="flex gap-1 px-5 pb-2 shrink-0 bg-black">
        {steps.map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < step   ? 'bg-blue-500' :
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

      {/* Camera — re-mounts on each step change via key */}
      <EstimatorCamera
        key={keyRef.current}
        stepLabel={currentStep.label}
        stepHint={currentStep.hint}
        orientation={currentStep.orientation}
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

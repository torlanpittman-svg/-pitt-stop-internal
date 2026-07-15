'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'

const STEPS = [
  { label: 'Photos uploaded',      delay: 0    },
  { label: 'AI analyzing vehicle', delay: 800  },
  { label: 'Generating estimate',  delay: 2000 },
]

export default function AnalyzingPage() {
  const router = useRouter()
  const { id } = useParams<{ id: string }>()

  const [currentStep, setCurrentStep] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      // Animate step labels
      for (let i = 1; i < STEPS.length; i++) {
        await new Promise(r => setTimeout(r, STEPS[i].delay - (STEPS[i - 1]?.delay ?? 0)))
        if (cancelled) return
        setCurrentStep(i)
      }

      // Call the analyze endpoint
      try {
        const res = await fetch(`/api/estimator/estimates/${id}/analyze`, {
          method: 'POST',
        })
        const data = await res.json() as { error?: string }
        if (!res.ok) throw new Error(data.error ?? 'Analysis failed')

        if (!cancelled) {
          router.push(`/estimator/${id}/review`)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    run()
    return () => { cancelled = true }
  }, [id, router])

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 gap-8">
      {error ? (
        <div className="text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-red-900/60 border-2 border-red-700 flex items-center justify-center mx-auto">
            <span className="text-red-400 text-2xl">✕</span>
          </div>
          <p className="text-red-300 font-semibold">Analysis failed</p>
          <p className="text-gray-500 text-sm">{error}</p>
          <button
            onClick={() => router.push(`/estimator/${id}/photo-review`)}
            className="text-blue-400 text-sm underline"
          >
            ← Go back
          </button>
        </div>
      ) : (
        <>
          {/* Spinner */}
          <div className="relative w-20 h-20">
            <div className="absolute inset-0 rounded-full border-4 border-gray-800" />
            <div className="absolute inset-0 rounded-full border-4 border-t-blue-500 animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
                <span className="text-white font-black text-base leading-none">P</span>
              </div>
            </div>
          </div>

          {/* Step list */}
          <div className="space-y-3 w-full max-w-xs">
            {STEPS.map((step, i) => {
              const done    = i < currentStep
              const active  = i === currentStep
              const pending = i > currentStep
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs font-bold
                    ${done    ? 'bg-green-600 text-white' :
                      active  ? 'bg-blue-600 text-white animate-pulse' :
                                'bg-gray-800 text-gray-600'}`}
                  >
                    {done ? '✓' : active ? '⟳' : '○'}
                  </div>
                  <span className={`text-sm ${done ? 'text-green-400' : active ? 'text-white' : 'text-gray-600'}`}>
                    {step.label}
                  </span>
                </div>
              )
            })}
          </div>

          <p className="text-gray-600 text-xs text-center max-w-xs">
            AI is reviewing your photos and building a service estimate.
          </p>
        </>
      )}
    </main>
  )
}

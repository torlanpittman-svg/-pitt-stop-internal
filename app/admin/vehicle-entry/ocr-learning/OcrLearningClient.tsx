'use client'

import { useState } from 'react'

export default function OcrLearningClient({
  entryIds,
  rerunCount,
}: {
  entryIds: string[]
  rerunCount: number
}) {
  const [running,  setRunning]  = useState(false)
  const [progress, setProgress] = useState(0)
  const [done,     setDone]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  async function handleRerun() {
    if (!confirm(
      `Re-run ${entryIds.length} saved photos through the current prompt.\n\n` +
      `This creates new entries in ocr_prompt_results for comparison.\n` +
      `Employee-confirmed values are never changed.\n\nContinue?`
    )) return

    setRunning(true)
    setProgress(0)
    setDone(false)
    setError(null)

    // Process one at a time to avoid timeout; each call is ~3s
    let completed = 0
    for (const id of entryIds) {
      try {
        const res = await fetch('/api/vehicle-entry/ocr-rerun', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ entryId: id }),
        })
        if (!res.ok) {
          const t = await res.text()
          console.warn(`Re-run failed for ${id}:`, t)
        }
      } catch (err) {
        console.warn(`Re-run error for ${id}:`, err)
      }
      completed++
      setProgress(completed)
    }

    setRunning(false)
    setDone(true)
    // Refresh to show updated stats
    window.location.reload()
  }

  return (
    <section>
      <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Re-run Dataset</h2>
      <div className="bg-gray-900 rounded-2xl p-5">
        <p className="text-gray-400 text-sm mb-1">
          Re-process all {entryIds.length} saved photo{entryIds.length !== 1 ? 's' : ''} with the current prompt version.
          Results are saved to <span className="font-mono text-gray-300">ocr_prompt_results</span> for comparison.
          Employee-confirmed values are never changed.
        </p>
        {rerunCount > 0 && (
          <p className="text-gray-600 text-xs mb-4">{rerunCount} re-run result{rerunCount !== 1 ? 's' : ''} already stored.</p>
        )}
        <p className="text-yellow-600 text-xs mb-4">
          Note: The AI does not learn automatically. Use these results to identify patterns,
          improve prompts, or compare model versions manually.
        </p>

        {running ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              <span className="text-blue-300 text-sm">
                Processing {progress} / {entryIds.length}…
              </span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all"
                style={{ width: `${(progress / entryIds.length) * 100}%` }}
              />
            </div>
          </div>
        ) : done ? (
          <p className="text-green-400 text-sm">Done. Page reloading…</p>
        ) : error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : (
          <button
            onClick={handleRerun}
            disabled={entryIds.length === 0}
            className="text-sm px-4 py-2 rounded-xl border border-blue-800 text-blue-400 hover:border-blue-600 hover:text-blue-300 transition-colors disabled:opacity-40"
          >
            Re-run {entryIds.length} photo{entryIds.length !== 1 ? 's' : ''} →
          </button>
        )}
      </div>
    </section>
  )
}

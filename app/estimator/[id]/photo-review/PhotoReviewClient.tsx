'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function PhotoReviewClient({ estimateId }: { estimateId: string }) {
  const router  = useRouter()
  const [going, setGoing] = useState(false)

  function proceed() {
    setGoing(true)
    router.push(`/estimator/${estimateId}/analyzing`)
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800 space-y-3">
      <button
        onClick={proceed}
        disabled={going}
        className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 text-white font-bold text-lg transition-colors"
      >
        {going ? 'Loading…' : 'Looks Good — Analyze →'}
      </button>
      <Link
        href={`/estimator/${estimateId}/photos`}
        className="block text-center text-gray-500 text-sm py-1 hover:text-gray-300 transition-colors"
      >
        Retake photos
      </Link>
    </div>
  )
}

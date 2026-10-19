'use client'

import { useTransition } from 'react'
import { acknowledgeAction } from './actions'

export default function AcknowledgeButton({ ids }: { ids: string[] }) {
  const [pending, start] = useTransition()
  return (
    <button type="button" disabled={pending} onClick={() => start(async () => { await acknowledgeAction(ids) })}
      className="rounded-lg border border-emerald-700 px-3 py-1.5 text-sm text-emerald-200 disabled:opacity-60">
      {pending ? 'Marking…' : 'Mark seen'}
    </button>
  )
}

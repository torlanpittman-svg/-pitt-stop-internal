'use client'
import { useState } from 'react'

/** Small copy-to-clipboard button for sharing the public opt-in link. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* no-op */ }
      }}
      className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
    >
      {copied ? 'Copied ✓' : label}
    </button>
  )
}

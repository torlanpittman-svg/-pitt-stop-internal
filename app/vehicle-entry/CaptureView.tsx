'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

// ── Types ─────────────────────────────────────────────────────────────────────

type CaptureState = 'idle' | 'scanning' | 'error'

type LogEntry = {
  t: string
  msg: string
  kind: 'info' | 'ok' | 'err'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function kb(bytes: number) {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(0)}KB`
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CaptureView({
  showSuccess,
  isDemoMode,
}: {
  showSuccess: boolean
  isDemoMode: boolean
}) {
  const [jsLoaded, setJsLoaded]   = useState(false)
  const [state, setState]         = useState<CaptureState>('idle')
  const [errorMsg, setErrorMsg]   = useState<string | null>(null)
  const [logs, setLogs]           = useState<LogEntry[]>([])
  const [inputKey, setInputKey]   = useState(0)
  const router = useRouter()

  // Fires only on the client after hydration — proves React is running
  useEffect(() => { setJsLoaded(true) }, [])

  const log = useCallback((msg: string, kind: LogEntry['kind'] = 'info') => {
    console.log(`[VE] ${msg}`)
    setLogs((prev) => [...prev, { t: ts(), msg, kind }])
  }, [])

  // ── OCR flow ─────────────────────────────────────────────────────────────

  const doOCR = useCallback(async (file: File) => {
    log(`onChange fired — ${file.name} ${kb(file.size)} ${file.type}`)
    setState('scanning')
    setErrorMsg(null)

    // Skip compression — send the original file.
    // browser-image-compression was removed because its eager-loaded chunk
    // was preventing React hydration on mobile Chrome.
    const toUpload: File = file
    log(`Using original file (${kb(file.size)})`)

    log('POST /api/vehicle-entry/ocr…')
    let res: Response
    try {
      const fd = new FormData()
      fd.append('image', toUpload, file.name)
      res = await fetch('/api/vehicle-entry/ocr', { method: 'POST', body: fd })
    } catch (err) {
      const msg = `Network error — ${String(err)}`
      log(msg, 'err')
      setErrorMsg(msg)
      setState('error')
      setInputKey((k) => k + 1)
      return
    }

    log(`OCR HTTP ${res.status}`)
    let data: Record<string, unknown>
    try {
      data = await res.json()
    } catch {
      const msg = `Could not parse response (HTTP ${res.status})`
      log(msg, 'err')
      setErrorMsg(msg)
      setState('error')
      setInputKey((k) => k + 1)
      return
    }

    if (!res.ok) {
      const msg = (data.error as string) ?? `OCR failed (HTTP ${res.status})`
      log(`Error: ${msg}`, 'err')
      setErrorMsg(msg)
      setState('error')
      setInputKey((k) => k + 1)
      return
    }

    log(`Success — id: ${data.id} make: ${data.make}`, 'ok')
    router.push(`/vehicle-entry/confirm/${data.id as string}`)
  }, [log, router])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) { log('onChange: no file', 'err'); return }
    doOCR(f)
  }, [log, doOCR])

  const handleTestJS = useCallback(async () => {
    log('JS test button tapped')
    setState('scanning')
    setErrorMsg(null)
    try {
      log('POST /api/vehicle-entry/test…')
      const res = await fetch('/api/vehicle-entry/test', { method: 'POST' })
      log(`HTTP ${res.status}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Test failed')
      log(`id: ${data.id}`, 'ok')
      router.push(`/vehicle-entry/confirm/${data.id as string}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`ERROR: ${msg}`, 'err')
      setErrorMsg(msg)
      setState('error')
    }
  }, [log, router])

  const handleManualEntry = useCallback(async () => {
    log('Manual entry tapped')
    setState('scanning')
    setErrorMsg(null)
    try {
      const res = await fetch('/api/vehicle-entry/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      log(`Manual id: ${data.id}`, 'ok')
      router.push(`/vehicle-entry/confirm/${data.id as string}?mode=manual`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`ERROR: ${msg}`, 'err')
      setErrorMsg(msg)
      setState('error')
    }
  }, [log, router])

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <main style={{ minHeight: '100vh', background: '#09090b', color: '#fff', fontFamily: 'system-ui, sans-serif', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <a href="/" style={{ color: '#6b7280', fontSize: '0.875rem', textDecoration: 'none' }}>← Home</a>
        <span style={{ fontWeight: 600 }}>Vehicle Entry</span>
        <span style={{ width: '3rem' }} />
      </div>

      {showSuccess && (
        <div style={{ background: '#14532d', border: '1px solid #16a34a', borderRadius: '0.75rem', padding: '0.75rem 1rem', fontSize: '0.875rem', color: '#86efac' }}>
          ✓ Entry saved — ready for the next key tag
        </div>
      )}

      {/* ── DIAGNOSTIC SECTION — plain HTML, no JS required ───────────────── */}
      <div style={{ background: '#1c1917', border: '1px solid #44403c', borderRadius: '0.75rem', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ fontSize: '0.7rem', color: '#78716c', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Diagnostics
        </div>

        {/* JS hydration check — changes from server-rendered value only after React mounts */}
        <div style={{ fontSize: '0.8125rem', fontFamily: 'monospace' }}>
          JavaScript:&nbsp;
          {jsLoaded
            ? <span style={{ color: '#4ade80' }}>✓ loaded</span>
            : <span style={{ color: '#f87171' }}>✗ not loaded (buttons will not work)</span>
          }
        </div>

        {/* Plain anchor — tests routing with zero JS */}
        <a
          href="/vehicle-entry/confirm/test"
          style={{ display: 'block', background: '#1e3a5f', border: '1px solid #1d4ed8', borderRadius: '0.625rem', padding: '0.75rem 1rem', textAlign: 'center', color: '#93c5fd', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 600 }}
        >
          Open Test Confirm Page (no JS)
        </a>

        {/* Plain form POST — tests API + redirect with zero JS */}
        <form action="/api/vehicle-entry/test" method="POST" style={{ margin: 0 }}>
          <button
            type="submit"
            style={{ width: '100%', background: '#4c1d95', border: '1px solid #7c3aed', borderRadius: '0.625rem', padding: '0.75rem 1rem', color: '#c4b5fd', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer' }}
          >
            Create Test Entry Without JS (form POST)
          </button>
        </form>

        {/* Plain link — server creates entry + redirects, no JS needed */}
        <a
          href="/vehicle-entry/test"
          style={{ display: 'block', background: '#1a2e1a', border: '1px solid #15803d', borderRadius: '0.625rem', padding: '0.75rem 1rem', textAlign: 'center', color: '#86efac', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 600 }}
        >
          Create Test Entry via Server Link (no JS)
        </a>
      </div>

      {/* ── DEBUG LOG — shows on-screen after any JS action ──────────────── */}
      {logs.length > 0 && (
        <div style={{ background: '#0c0a09', border: '1px solid #292524', borderRadius: '0.75rem', padding: '0.75rem', fontFamily: 'monospace', fontSize: '0.75rem' }}>
          <div style={{ color: '#57534e', marginBottom: '0.5rem', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Debug log — state: <span style={{ color: state === 'error' ? '#f87171' : state === 'scanning' ? '#60a5fa' : '#a8a29e' }}>{state}</span>
          </div>
          <div style={{ maxHeight: '10rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {logs.map((l, i) => (
              <div key={i} style={{ color: l.kind === 'err' ? '#f87171' : l.kind === 'ok' ? '#4ade80' : '#d6d3d1' }}>
                <span style={{ color: '#57534e' }}>{l.t} </span>{l.msg}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ERROR DISPLAY ─────────────────────────────────────────────────── */}
      {errorMsg && (
        <div style={{ background: '#450a0a', border: '1px solid #dc2626', borderRadius: '0.75rem', padding: '0.75rem 1rem', fontSize: '0.875rem', color: '#fca5a5' }}>
          ⚠ {errorMsg}
        </div>
      )}

      {/* ── MAIN ACTIONS ──────────────────────────────────────────────────── */}
      {state !== 'scanning' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {isDemoMode && (
            <div style={{ background: '#451a03', border: '1px solid #92400e', borderRadius: '0.75rem', padding: '0.75rem 1rem', fontSize: '0.8125rem', color: '#fcd34d' }}>
              Demo mode — mock OCR active
            </div>
          )}

          {/* Photo upload button — input overlay pattern */}
          <div style={{ position: 'relative', width: '100%' }}>
            <div style={{ background: '#1d4ed8', borderRadius: '1rem', padding: '2.25rem 1rem', textAlign: 'center', fontSize: '1.25rem', fontWeight: 700, pointerEvents: 'none', userSelect: 'none' }}>
              📷&nbsp; Take Key Tag Photo
            </div>
            <input
              key={inputKey}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', zIndex: 10, fontSize: '16px' }}
            />
          </div>

          {/* JS test button */}
          <button
            onClick={handleTestJS}
            style={{ background: '#581c87', border: 'none', borderRadius: '1rem', padding: '1rem', color: '#e9d5ff', fontWeight: 600, fontSize: '1rem', cursor: 'pointer', width: '100%' }}
          >
            🧪 Test Mock OCR (JS button)
          </button>

          <button
            onClick={handleManualEntry}
            style={{ background: 'transparent', border: 'none', color: '#6b7280', fontSize: '0.875rem', cursor: 'pointer', textDecoration: 'underline', padding: '0.5rem' }}
          >
            Enter vehicle info manually instead
          </button>
        </div>
      )}

      {/* ── SCANNING STATE ────────────────────────────────────────────────── */}
      {state === 'scanning' && (
        <div style={{ textAlign: 'center', padding: '2rem 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <div style={{ width: '3rem', height: '3rem', border: '4px solid #3b82f6', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <p style={{ color: '#9ca3af', fontSize: '0.875rem' }}>
            {isDemoMode ? 'Mock AI extracting vehicle data…' : 'AI reading handwritten tag…'}
          </p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ── ERROR RECOVERY ────────────────────────────────────────────────── */}
      {state === 'error' && (
        <button
          onClick={() => { setState('idle'); setErrorMsg(null); setInputKey((k) => k + 1) }}
          style={{ background: 'transparent', border: '1px solid #374151', borderRadius: '0.75rem', padding: '0.75rem', color: '#9ca3af', fontSize: '0.875rem', cursor: 'pointer' }}
        >
          ← Reset
        </button>
      )}
    </main>
  )
}

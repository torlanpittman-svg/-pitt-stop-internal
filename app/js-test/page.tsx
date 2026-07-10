'use client'

// Zero external dependencies — bare React only.
// Tests whether ANY client JS works on this device/browser.
import { useState, useEffect } from 'react'

export default function JsTestPage() {
  const [loaded, setLoaded] = useState(false)
  const [count, setCount]   = useState(0)
  const [ua, setUa]         = useState('')

  useEffect(() => {
    setLoaded(true)
    setUa(navigator.userAgent)
  }, [])

  const box = (ok: boolean, yes: string, no: string) => ({
    background: ok ? '#14532d' : '#450a0a',
    border: `1px solid ${ok ? '#16a34a' : '#dc2626'}`,
    borderRadius: '0.75rem',
    padding: '1rem',
    color: ok ? '#86efac' : '#fca5a5',
    fontWeight: 700,
    fontSize: '1.125rem',
  })

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui', background: '#09090b', color: '#fff', minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

      <h1 style={{ margin: 0, fontSize: '1.25rem' }}>JavaScript Test Page</h1>
      <p style={{ margin: 0, color: '#6b7280', fontSize: '0.875rem' }}>No external deps — bare React only</p>

      {/* Hydration check */}
      <div style={box(loaded, '', '')}>
        JavaScript: {loaded ? '✓ LOADED — React hydrated successfully' : '✗ NOT LOADED — React did not hydrate'}
      </div>

      {/* Click handler check */}
      <div>
        <button
          onClick={() => setCount(c => c + 1)}
          style={{ background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: '0.75rem', padding: '1rem 2rem', fontSize: '1rem', cursor: 'pointer', width: '100%' }}
        >
          Tap to test onClick — tapped {count} time{count !== 1 ? 's' : ''}
        </button>
      </div>

      {/* fetch check */}
      <FetchTest />

      {/* Device info */}
      {loaded && (
        <div style={{ background: '#111', border: '1px solid #333', borderRadius: '0.75rem', padding: '1rem', fontSize: '0.75rem', color: '#9ca3af', wordBreak: 'break-all' }}>
          <div style={{ color: '#fff', marginBottom: '0.5rem' }}>Device</div>
          <div>{ua}</div>
        </div>
      )}

      <a href="/vehicle-entry" style={{ color: '#60a5fa', textDecoration: 'none', fontSize: '0.875rem' }}>
        ← Back to Vehicle Entry
      </a>
    </div>
  )
}

function FetchTest() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'fail'>('idle')
  const [detail, setDetail] = useState('')

  const run = async () => {
    setStatus('loading')
    setDetail('')
    try {
      const res = await fetch('/api/health')
      const data = await res.json()
      setStatus('ok')
      setDetail(`HTTP ${res.status} — ${JSON.stringify(data)}`)
    } catch (err) {
      setStatus('fail')
      setDetail(String(err))
    }
  }

  const colors: Record<string, string> = {
    idle: '#374151', loading: '#1e40af', ok: '#14532d', fail: '#450a0a',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <button
        onClick={run}
        style={{ background: colors[status], color: '#fff', border: 'none', borderRadius: '0.75rem', padding: '1rem', fontSize: '1rem', cursor: 'pointer' }}
      >
        {status === 'idle'    && 'Test fetch() API call'}
        {status === 'loading' && '⏳ Fetching…'}
        {status === 'ok'      && '✓ fetch() works'}
        {status === 'fail'    && '✗ fetch() failed'}
      </button>
      {detail && (
        <div style={{ fontSize: '0.75rem', color: '#9ca3af', wordBreak: 'break-all' }}>{detail}</div>
      )}
    </div>
  )
}

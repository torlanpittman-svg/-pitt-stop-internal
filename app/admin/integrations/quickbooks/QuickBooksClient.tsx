'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'

interface ConnectionStatus {
  connected:             boolean
  realmId:               string | null
  environment:           string
  status:                string | null
  accessTokenExpiresAt:  string | null
  refreshTokenExpiresAt: string | null
  connectedBy:           string | null
  lastUsedAt:            string | null
  lastRefreshedAt:       string | null
  lastError:             string | null
}

interface ConfigDiagnostics {
  clientId:      boolean
  clientSecret:  boolean
  redirectUri:   string | null
  environment:   string
  encryptionKey: boolean
}

const ERROR_MESSAGES: Record<string, string> = {
  missing_params:        'Intuit did not return the expected parameters. Try connecting again.',
  state_mismatch:        'Security check failed (state mismatch). Try connecting again.',
  token_exchange_failed: 'Could not exchange the authorization code for tokens. Check the client secret and redirect URI.',
  access_denied:         'Authorization was declined in the Intuit window.',
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString()
}

function relative(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(ms)
  const mins = Math.round(abs / 60000)
  const hrs  = Math.round(abs / 3600000)
  const days = Math.round(abs / 86400000)
  const label = days >= 1 ? `${days}d` : hrs >= 1 ? `${hrs}h` : `${mins}m`
  return ms >= 0 ? `in ${label}` : `${label} ago`
}

export default function QuickBooksClient({
  initialStatus,
  initialConfig,
  banner,
}: {
  initialStatus: ConnectionStatus
  initialConfig: ConfigDiagnostics
  banner: { connected?: boolean; error?: string; realm?: string }
}) {
  const [status, setStatus] = useState(initialStatus)
  const [config, setConfig] = useState(initialConfig)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const reload = useCallback(async () => {
    const res = await fetch('/api/auth/quickbooks/status')
    if (!res.ok) return
    const data = await res.json()
    setStatus(data.status)
    setConfig(data.config)
  }, [])

  const runTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/auth/quickbooks/test')
      const data = await res.json()
      if (data.ok) {
        setTestResult({ ok: true, message: `Connected to "${data.company.companyName}" (${data.company.country || 'US'})` })
      } else {
        setTestResult({ ok: false, message: data.error ?? 'Test failed' })
      }
    } catch (err) {
      setTestResult({ ok: false, message: String(err) })
    } finally {
      setTesting(false)
      void reload()
    }
  }, [reload])

  const disconnect = useCallback(async () => {
    if (!confirm('Disconnect QuickBooks? Pitt Stop will stop syncing until you reconnect.')) return
    setDisconnecting(true)
    try {
      await fetch('/api/auth/quickbooks/disconnect', { method: 'POST' })
      setTestResult(null)
      await reload()
    } finally {
      setDisconnecting(false)
    }
  }, [reload])

  const configReady = config.clientId && config.clientSecret && Boolean(config.redirectUri) && config.encryptionKey
  const isActive = status.connected && status.status === 'active'

  const statusColor = isActive ? 'text-green-400' : status.status === 'expired' ? 'text-amber-400' : status.status === 'revoked' ? 'text-gray-400' : 'text-gray-500'
  const statusDot   = isActive ? 'bg-green-400' : status.status === 'expired' ? 'bg-amber-400' : 'bg-gray-600'
  const statusLabel = isActive ? 'Connected' : status.status === 'expired' ? 'Expired — reconnect needed' : status.status === 'revoked' ? 'Disconnected' : 'Not connected'

  return (
    <main className="min-h-screen bg-gray-950 px-6 pt-12 pb-16">
      <div className="max-w-2xl mx-auto">
        <Link href="/admin" className="text-gray-500 text-sm block mb-8 hover:text-gray-300 transition-colors">← Admin</Link>

        <h1 className="text-white font-bold text-2xl mb-1">QuickBooks Integration</h1>
        <p className="text-gray-500 text-sm mb-8">Connect Pitt Stop OS directly to your QuickBooks Online company.</p>

        {/* Post-redirect banners */}
        {banner.connected && (
          <div className="mb-6 rounded-xl border border-green-800 bg-green-950/40 px-4 py-3 text-green-300 text-sm">
            ✓ QuickBooks connected{banner.realm ? ` (company ${banner.realm})` : ''}.
          </div>
        )}
        {banner.error && (
          <div className="mb-6 rounded-xl border border-red-900 bg-red-950/40 px-4 py-3 text-red-300 text-sm">
            {ERROR_MESSAGES[banner.error] ?? `Connection error: ${banner.error}`}
          </div>
        )}

        {/* Status card */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 mb-6">
          <div className="flex items-center gap-2.5 mb-5">
            <span className={`w-2.5 h-2.5 rounded-full ${statusDot}`} />
            <span className={`font-semibold ${statusColor}`}>{statusLabel}</span>
            <span className="ml-auto text-xs uppercase tracking-widest text-gray-600">{status.environment}</span>
          </div>

          <dl className="space-y-2.5 text-sm">
            <Row label="Company (realm) ID" value={status.realmId ?? '—'} />
            <Row label="Access token expires" value={status.accessTokenExpiresAt ? `${fmt(status.accessTokenExpiresAt)} (${relative(status.accessTokenExpiresAt)})` : '—'} />
            <Row label="Refresh token expires" value={status.refreshTokenExpiresAt ? `${fmt(status.refreshTokenExpiresAt)} (${relative(status.refreshTokenExpiresAt)})` : '—'} />
            <Row label="Last used" value={fmt(status.lastUsedAt)} />
            <Row label="Last refreshed" value={fmt(status.lastRefreshedAt)} />
            {status.lastError && <Row label="Last error" value={status.lastError} valueClass="text-red-400" />}
          </dl>

          <div className="flex flex-wrap gap-3 mt-6">
            {!isActive && (
              <a
                href="/api/auth/quickbooks/connect"
                className={`px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors ${configReady ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-gray-800 text-gray-500 cursor-not-allowed pointer-events-none'}`}
              >
                {status.status === 'expired' || status.status === 'revoked' ? 'Reconnect QuickBooks' : 'Connect QuickBooks'}
              </a>
            )}
            {isActive && (
              <>
                <button
                  onClick={runTest}
                  disabled={testing}
                  className="px-5 py-2.5 rounded-xl font-semibold text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors"
                >
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
                <button
                  onClick={disconnect}
                  disabled={disconnecting}
                  className="px-5 py-2.5 rounded-xl font-semibold text-sm border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </>
            )}
          </div>

          {testResult && (
            <div className={`mt-4 rounded-xl px-4 py-3 text-sm border ${testResult.ok ? 'border-green-800 bg-green-950/40 text-green-300' : 'border-red-900 bg-red-950/40 text-red-300'}`}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
            </div>
          )}
        </div>

        {/* Config diagnostics */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4">Configuration</h2>
          <dl className="space-y-2.5 text-sm">
            <CheckRow label="Client ID" ok={config.clientId} />
            <CheckRow label="Client Secret" ok={config.clientSecret} />
            <CheckRow label="Encryption Key" ok={config.encryptionKey} />
            <Row label="Redirect URI" value={config.redirectUri ?? '— not set —'} valueClass={config.redirectUri ? 'text-gray-300' : 'text-red-400'} />
            <Row label="Environment" value={config.environment} />
          </dl>
          {!configReady && (
            <p className="mt-4 text-xs text-amber-400">
              Set the missing values in <code className="text-amber-300">.env.local</code> and restart the dev server before connecting.
            </p>
          )}
        </div>
      </div>
    </main>
  )
}

function Row({ label, value, valueClass = 'text-gray-300' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-gray-500 shrink-0">{label}</dt>
      <dd className={`text-right break-all ${valueClass}`}>{value}</dd>
    </div>
  )
}

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className={ok ? 'text-green-400' : 'text-red-400'}>{ok ? '✓ set' : '✗ missing'}</dd>
    </div>
  )
}

'use client'

/**
 * "Enable notifications on this device" — the whole enrolment flow in one button.
 *
 * Standard Web Push: the browser itself creates the subscription against our public VAPID key and
 * hands us an endpoint belonging to Apple/Google/Mozilla. No account, no third-party SDK, nothing to
 * sign up for. The private key stays on the server.
 *
 * iPhone/iPad reality this screen is built around: Safari only exposes PushManager to a site that has
 * been added to the Home Screen (iOS 16.4+). In a normal Safari tab there is literally no push API,
 * so the honest thing is to detect that and show the install steps rather than a button that cannot
 * work. Permission is also requested as the FIRST thing the tap does — Safari ignores a permission
 * prompt that comes after an await.
 */
import { useCallback, useEffect, useState } from 'react'

type Phase = 'checking' | 'unsupported' | 'needs-install' | 'not-configured' | 'blocked' | 'off' | 'on'

interface Device { id: string; label: string | null; enrolledAt: string; lastSuccessAt: string | null }

/** The browser wants the VAPID public key as raw bytes, not base64url. */
function keyBytes(base64url: string): Uint8Array {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
const toBase64Url = (buf: ArrayBuffer | null | undefined): string =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : ''

const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true)

/** iPadOS 13+ reports a Macintosh user agent, so touch points are what separate an iPad from a Mac. */
const isApple = () => typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

/** A human name for this device, so the list is readable. Never a fingerprint. */
function deviceLabel(): string {
  const ua = navigator.userAgent
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Device'
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${browser}`
}

export default function EnableNotifications() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [devices, setDevices] = useState<Device[]>([])

  const loadServer = useCallback(async (): Promise<{ configured: boolean; publicKey: string | null } | null> => {
    try {
      const res = await fetch('/api/appointments/push', { cache: 'no-store' })
      if (!res.ok) return null
      const data = await res.json() as { configured: boolean; publicKey: string | null; devices: Device[] }
      setPublicKey(data.publicKey)
      setDevices(data.devices ?? [])
      return data
    } catch { return null }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
      if (!supported) {
        // On an iPhone this almost always means "opened in a Safari tab, not the installed app".
        if (!cancelled) setPhase(isApple() && !isStandalone() ? 'needs-install' : 'unsupported')
        return
      }
      const server = await loadServer()
      if (cancelled) return
      if (!server?.configured || !server.publicKey) { setPhase('not-configured'); return }
      if (Notification.permission === 'denied') { setPhase('blocked'); return }

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (cancelled) return
      // A subscription made against an older VAPID key can never be delivered to. Reporting it as
      // "on" would be the worst outcome: the phone looks covered, every push comes back rejected and
      // there is no Enable button left to repair it. Treat it as off so the fix is one tap.
      const staleKey = !!sub && toBase64Url(sub.options.applicationServerKey) !== server.publicKey
      if (sub && !staleKey && Notification.permission === 'granted') {
        // Refresh the server's copy: it keeps last-seen current and re-points a shared shop phone at
        // whoever is signed in now.
        void fetch('/api/appointments/push', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...subscriptionFields(sub), label: deviceLabel() }),
        }).then(() => loadServer())
        setPhase('on')
      } else {
        if (staleKey) setError('This device was set up with an older notification key. Tap Enable to reconnect it.')
        setPhase('off')
      }
    })()
    return () => { cancelled = true }
  }, [loadServer])

  const enable = useCallback(async () => {
    setError(null); setMessage(null); setBusy(true)
    try {
      // FIRST, inside the tap: Safari ignores a permission request made after an await.
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
      if (permission !== 'granted') {
        setPhase(permission === 'denied' ? 'blocked' : 'off')
        setError(permission === 'denied' ? 'Notifications are blocked for this app in iPhone Settings.' : 'Permission was not granted.')
        return
      }
      const key = publicKey ?? (await loadServer())?.publicKey
      if (!key) { setPhase('not-configured'); return }

      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      // A subscription made against an older VAPID key can never be sent to — replace it.
      if (sub && toBase64Url(sub.options.applicationServerKey) !== key) {
        await sub.unsubscribe().catch(() => {})
        sub = null
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource })

      const res = await fetch('/api/appointments/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subscriptionFields(sub), label: deviceLabel() }),
      })
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) { setError(data.error ?? 'Could not register this device.'); return }
      setPhase('on')
      setMessage('This device will now get a notification when a customer books online.')
      await loadServer()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn notifications on.')
    } finally { setBusy(false) }
  }, [publicKey, loadServer])

  const disable = useCallback(async () => {
    setError(null); setMessage(null); setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await fetch('/api/appointments/push', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint, reason: 'disabled_by_staff' }),
        }).catch(() => {})
        await sub.unsubscribe().catch(() => {})
      }
      setPhase('off')
      setMessage('This device will no longer get booking notifications.')
      await loadServer()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn notifications off.')
    } finally { setBusy(false) }
  }, [loadServer])

  const sendTest = useCallback(async () => {
    setError(null); setMessage(null); setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (!sub) { setPhase('off'); setError('This device is not enrolled yet.'); return }
      const res = await fetch('/api/appointments/push/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }),
      })
      const data = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string }
      if (res.ok && data.ok) setMessage(data.message ?? 'Test notification sent.')
      else setError(data.error ?? 'Could not send a test notification.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a test notification.')
    } finally { setBusy(false) }
  }, [])

  return (
    <div className="space-y-4">
      <Status phase={phase} />

      {(phase === 'off' || phase === 'on') && (
        <div className="flex flex-wrap gap-2">
          {phase === 'off' ? (
            <button type="button" onClick={enable} disabled={busy}
              className="min-h-11 rounded-xl bg-emerald-500 px-5 text-base font-semibold text-gray-950 disabled:opacity-60">
              {busy ? 'Turning on…' : 'Enable notifications on this device'}
            </button>
          ) : (
            <>
              <button type="button" onClick={sendTest} disabled={busy}
                className="min-h-11 rounded-xl bg-emerald-500 px-5 text-base font-semibold text-gray-950 disabled:opacity-60">
                {busy ? 'Working…' : 'Send a test notification'}
              </button>
              <button type="button" onClick={disable} disabled={busy}
                className="min-h-11 rounded-xl border border-gray-700 px-5 text-base text-gray-200 disabled:opacity-60">
                Turn off on this device
              </button>
            </>
          )}
        </div>
      )}

      {message && <p role="status" className="rounded-xl border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-100">{message}</p>}
      {error && <p role="alert" className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}

      {devices.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <h2 className="text-sm font-semibold text-gray-200">Your devices getting alerts</h2>
          <ul className="mt-2 space-y-1 text-sm text-gray-400">
            {devices.map((d) => (
              <li key={d.id} className="break-words">
                {d.label ?? 'Device'} — added {new Date(d.enrolledAt).toLocaleDateString()}
                {d.lastSuccessAt ? ` · last alert ${new Date(d.lastSuccessAt).toLocaleString()}` : ' · no alert sent yet'}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">Each phone or computer has to be turned on separately. Signing out removes that device.</p>
        </div>
      )}
    </div>
  )
}

function subscriptionFields(sub: PushSubscription): { endpoint: string; p256dh: string; auth: string } {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  return { endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }
}

function Status({ phase }: { phase: Phase }) {
  if (phase === 'checking') return <p className="text-sm text-gray-400">Checking this device…</p>
  if (phase === 'on') return <Note tone="good">Notifications are ON for this device.</Note>
  if (phase === 'off') return <Note tone="plain">Notifications are off on this device.</Note>
  if (phase === 'not-configured') return <Note tone="warn">Push notifications are not set up on the server yet. An admin has to add the notification keys before this button can work.</Note>
  if (phase === 'blocked') return (
    <Note tone="warn">
      Notifications are blocked for Pitt Stop on this device. On iPhone: <strong>Settings → Notifications → Pitt Stop OS</strong> and turn <strong>Allow Notifications</strong> on, then come back and tap Enable.
    </Note>
  )
  if (phase === 'needs-install') return (
    <Note tone="warn">
      iPhone and iPad only allow notifications from the installed app, not from a Safari tab. Follow the install steps below first, then open Pitt Stop from your Home Screen and come back to this screen.
    </Note>
  )
  return <Note tone="warn">This browser cannot show push notifications. Use Safari on iPhone/iPad (installed to the Home Screen), or Chrome/Edge/Firefox on Android or a computer.</Note>
}

function Note({ tone, children }: { tone: 'good' | 'warn' | 'plain'; children: React.ReactNode }) {
  const cls = tone === 'good' ? 'border-emerald-800 bg-emerald-950/30 text-emerald-100'
    : tone === 'warn' ? 'border-amber-800 bg-amber-950/30 text-amber-100'
      : 'border-gray-800 bg-gray-900 text-gray-300'
  return <p className={`rounded-xl border p-3 text-sm ${cls}`}>{children}</p>
}

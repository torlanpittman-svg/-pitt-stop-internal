/*
 * Pitt Stop OS — network-first service worker.
 *
 * Purpose: keep the installed Home Screen (standalone) app from ever getting
 * stuck on a dead, cached build after a deploy. Navigations (the HTML app
 * shell) are ALWAYS fetched fresh from the network; the cache is only an
 * offline fallback. Static hashed assets and API calls are left to the browser.
 *
 * The SW activates immediately (skipWaiting + clients.claim) and purges old
 * caches, so a new deploy takes effect on the next open with no stale state.
 */
const CACHE = 'pittstop-shell-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  // Only touch our own origin — never intercept Intuit/OpenAI/etc.
  if (url.origin !== self.location.origin) return

  const accept = req.headers.get('accept') || ''
  const isNavigation = req.mode === 'navigate' || accept.includes('text/html')
  // Let static assets and API/JSON requests pass straight through to the network.
  if (!isNavigation) return

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req)
        try {
          const cache = await caches.open(CACHE)
          cache.put(req, fresh.clone())
        } catch {
          /* ignore cache write errors */
        }
        return fresh
      } catch (err) {
        const cached = await caches.match(req)
        if (cached) return cached
        throw err
      }
    })(),
  )
})

/* ───────────────────────────────────────────────────────────────────────────
 * Web Push — new online booking alerts.
 *
 * The payload is encrypted end-to-end to THIS device (RFC 8291), so the push
 * service never sees it. It still carries no customer details: a notification
 * is rendered on a lock screen anyone holding the phone can read.
 *
 * iOS/iPadOS only delivers Web Push to a site installed on the Home Screen
 * (Add to Home Screen, iOS 16.4+). In Safari's normal tab there is nothing to
 * deliver to, which is why the setup screen insists on installing first.
 * ─────────────────────────────────────────────────────────────────────────── */

const FALLBACK_NOTIFICATION = {
  title: 'Pitt Stop',
  body: 'Something needs your attention. Tap to open.',
  url: '/appointments?view=today',
  tag: 'pittstop-alert',
}

self.addEventListener('push', (event) => {
  let data = FALLBACK_NOTIFICATION
  try {
    // Every platform requires a visible notification for every push, so a missing or
    // unreadable payload still shows the generic one rather than silently dropping.
    const parsed = event.data ? event.data.json() : null
    if (parsed && typeof parsed === 'object') {
      data = {
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : FALLBACK_NOTIFICATION.title,
        body: typeof parsed.body === 'string' && parsed.body ? parsed.body : FALLBACK_NOTIFICATION.body,
        // Same-origin path only. '//host/x' is protocol-relative, i.e. another origin, so it is
        // rejected here rather than silently dropped later by notificationclick.
        url: typeof parsed.url === 'string' && /^\/(?!\/)/.test(parsed.url) ? parsed.url : FALLBACK_NOTIFICATION.url,
        tag: typeof parsed.tag === 'string' && parsed.tag ? parsed.tag : FALLBACK_NOTIFICATION.tag,
      }
    }
  } catch {
    /* keep the fallback */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // Same tag = the same booking. A retry replaces the notification instead of stacking another.
      tag: data.tag,
      renotify: false,
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      data: { url: data.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || FALLBACK_NOTIFICATION.url, self.location.origin)
  if (target.origin !== self.location.origin) return

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Reuse the already-open app window when there is one — on iOS a second window is not possible
      // anyway, and staff should land on the appointment, not a fresh cold start.
      for (const client of clientList) {
        if (new URL(client.url).origin !== self.location.origin) continue
        if ('navigate' in client) {
          const focused = await client.focus()
          try { await (focused || client).navigate(target.href) } catch { /* focus alone is enough */ }
          return
        }
        return client.focus()
      }
      if (self.clients.openWindow) await self.clients.openWindow(target.href)
    })(),
  )
})

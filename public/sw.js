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

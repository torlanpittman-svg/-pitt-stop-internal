'use client'

import { useEffect } from 'react'

/**
 * Registers the network-first service worker (public/sw.js) so the installed
 * Home Screen app always loads the current build and can never get stranded on
 * a dead cached shell after a deploy. Safe no-op where SW is unsupported.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* registration failures are non-fatal */
      })
    }
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [])
  return null
}

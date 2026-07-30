import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.1.64'],
  async headers() {
    return [
      {
        source: '/manifest.json',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json' }],
      },
      {
        // The service worker must always revalidate so SW updates apply on the
        // next open — never cache a stale sw.js.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        ],
      },
      {
        // Never serve a stale HTML app shell. iOS Home Screen apps otherwise
        // hold an old build whose hashed chunks 404 after a deploy (blank
        // screen). Matches page/API routes; excludes _next, icons, api assets
        // and any dotted static file (sw.js, manifest.json, favicon.ico, *.svg).
        source: '/((?!_next|icons|api|.*\\.).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ]
  },
}

export default nextConfig

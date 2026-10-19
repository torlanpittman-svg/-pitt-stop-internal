/**
 * Dedicated customer booking host. Like the SMS host (apps/marketing/public-host.ts), it never exposes
 * the OS: only the booking pages, their public APIs and the published policy pages are served.
 * The host needs a DNS record + Vercel domain before it is live; until then /book on the app's own
 * domain is used (it is public there too, outside the employee matcher).
 */
export const BOOKING_PUBLIC_HOSTS = ['book.pittstopdetailandautosales.com']

export function isBookingPublicHost(host: string): boolean {
  return BOOKING_PUBLIC_HOSTS.includes(host.toLowerCase().split(':')[0])
}

const TOKEN = '[A-Za-z0-9_-]{32}'

export function publicBookingRoute(pathname: string, method: string): 'allow' | 'redirect' | 'deny' {
  const read = method === 'GET' || method === 'HEAD'
  if (pathname === '/' && read) return 'redirect'
  if (read && (pathname === '/book' || new RegExp(`^/book/a/${TOKEN}$`).test(pathname))) return 'allow'
  if (read && (pathname === '/api/book/availability' || new RegExp(`^/api/book/a/${TOKEN}/ics$`).test(pathname))) return 'allow'
  if (method === 'POST' && (pathname === '/api/book/appointments' || new RegExp(`^/api/book/a/${TOKEN}/cancel$`).test(pathname))) return 'allow'
  if (read && (['/privacy', '/terms', '/favicon.ico'].includes(pathname) || pathname.startsWith('/_next/static/'))) return 'allow'
  return 'deny'
}

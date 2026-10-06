/** Only these dedicated customer hosts receive the public-only route policy. */
export function isMarketingPublicHost(host: string): boolean {
  return ['text.pittstopdetailandautosales.com'].includes(host.toLowerCase().split(':')[0])
}

export function publicMarketingRoute(pathname: string, method: string): 'allow' | 'redirect' | 'deny' {
  if (pathname === '/' && (method === 'GET' || method === 'HEAD')) return 'redirect'
  if (pathname === '/sms-opt-in' && ['GET', 'HEAD', 'POST'].includes(method)) return 'allow'
  if (/^\/unsubscribe\/[^/]+$/.test(pathname) && ['GET', 'HEAD', 'POST'].includes(method)) return 'allow'
  if (['GET', 'HEAD'].includes(method) && (
    ['/privacy', '/terms', '/favicon.ico'].includes(pathname) || pathname.startsWith('/_next/static/')
  )) return 'allow'
  return 'deny'
}

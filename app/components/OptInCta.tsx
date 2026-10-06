/**
 * Reusable customer-facing CTA + QR for the SMS opt-in flow. Drop on a website, print on an estimate,
 * or show at the counter. It only ever LINKS to the public opt-in page — it never collects a number
 * or sends anything (consent stays customer-controlled and affirmative).
 */
import type { ReactNode } from 'react'

/** QR image for a URL. Uses a public QR render service (the encoded data is a public URL — no secret).
 *  The raw URL is always shown too, so the tool works even if the image can't load. */
export function QrCode({ url, size = 200 }: { url: string; size?: number }) {
  if (!url) return <p className="text-sm text-amber-400">Set the public base URL to generate a QR code.</p>
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}`
  return (
    <div className="inline-flex flex-col items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} width={size} height={size} alt="SMS opt-in QR code" className="rounded-lg bg-white p-2" />
      <code className="max-w-[220px] break-all text-center text-xs text-gray-400">{url}</code>
    </div>
  )
}

export function OptInCta({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <a href={url || '/sms-opt-in'} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">
      {children ?? 'Get Pitt Stop specials by text'}
    </a>
  )
}

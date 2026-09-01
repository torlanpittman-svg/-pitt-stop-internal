import Link from 'next/link'

/**
 * The ONE shared Back affordance for Pitt Stop OS — same icon (←), text style, placement, and tap
 * target everywhere. Always points at a KNOWN internal parent route (never router.back(), so refresh /
 * login-redirect / external entry can't send the user somewhere unexpected). Native/iOS swipe-back is
 * unaffected. Used by NavHeader's `back` prop and directly by screens with a bespoke header (Auto Sales).
 */
export default function BackLink({ href, label, className = '' }: { href: string; label: string; className?: string }) {
  return (
    <Link href={href} className={`text-gray-400 hover:text-white flex items-center gap-1 ${className}`}>
      <span aria-hidden="true">←</span>{label}
    </Link>
  )
}

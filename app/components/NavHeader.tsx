import Link from 'next/link'
import type { ReactNode } from 'react'
import BackLink from './BackLink'

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
    </svg>
  )
}

/**
 * Shared top navigation used on every screen so employees never feel trapped:
 * an optional Back affordance on the left (for pages with a natural back flow)
 * and a consistent Home button on the right. `right` slots page-specific actions
 * (e.g. Dealer Check-In "Start Over") before Home.
 */
export default function NavHeader({ back, title, right }: {
  back?: { href: string; label: string }
  title?: string
  right?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 px-4 py-3 text-sm border-b border-gray-900 bg-gray-950/95 backdrop-blur shrink-0">
      {back && <BackLink href={back.href} label={back.label} />}
      {title && <span className="text-gray-300 font-medium truncate">{title}</span>}
      <div className="ml-auto flex items-center gap-3">
        {right}
        <Link href="/" aria-label="Home" className="flex items-center gap-1.5 text-gray-300 hover:text-white font-medium">
          <HomeIcon /><span>Home</span>
        </Link>
      </div>
    </header>
  )
}

import Link from 'next/link'
import type { ReactNode } from 'react'
import IdentityBar, { AdminLink } from '@/app/components/IdentityBar'
import GlobalSearch from '@/app/components/GlobalSearch'
import { PageContainer } from '@/app/components/ui/PageHeader'
import { managerActor } from '@/apps/checks/authz'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ModuleGroup = 'Operations' | 'Sales' | 'Money'
type IconKey = 'quick' | 'dealer' | 'board' | 'auto' | 'receipt' | 'estimate' | 'check'

interface Module {
  href: string
  label: string
  sub: string
  group: ModuleGroup
  icon: IconKey
  manager?: boolean
}

// Retail Estimator is intentionally hidden from the homepage — its route/code/data are untouched.
// `manager: true` tiles render only for a signed-in manager/admin (visibility only; routes are
// independently gated server-side).
const MODULES: Module[] = [
  { href: '/quick-entry', label: 'Quick Entry', sub: 'Customer + vehicle + services → Work Board in under a minute.', group: 'Operations', icon: 'quick' },
  { href: '/dealer-check-in', label: 'Dealer Check-In', sub: 'Scan a tag → confirm → done. Invoice + Work Board, automatically.', group: 'Operations', icon: 'dealer' },
  { href: '/work-board', label: 'Work Board', sub: 'Live vehicle workflow — check in, track status, assign techs.', group: 'Operations', icon: 'board' },
  { href: '/auto-sales', label: 'Auto Sales Inventory', sub: 'Owned vehicles — scan a VIN, track costs, record the sale.', group: 'Sales', icon: 'auto' },
  { href: '/estimates', label: 'Estimates', sub: 'Quote a customer, send through QuickBooks, move approved work to the board.', group: 'Sales', icon: 'estimate', manager: true },
  { href: '/expenses', label: 'Receipts', sub: 'Snap a business receipt — a manager reviews and files it.', group: 'Money', icon: 'receipt' },
  { href: '/checks', label: 'Write a Check', sub: 'Pay a vendor by check — QuickBooks + shop printer. Manager only.', group: 'Money', icon: 'check', manager: true },
]

const GROUP_ORDER: ModuleGroup[] = ['Operations', 'Sales', 'Money']

export default async function Home() {
  // Manager visibility (Torlan/Darryl/Tony/Bart) — not authorization; the routes gate themselves.
  const manager = await managerActor()
  const visible = MODULES.filter((m) => !m.manager || manager)

  return (
    <main className="flex min-h-screen flex-col bg-gray-950">
      {/* Identity + discreet global search */}
      <header className="border-b border-gray-900/80">
        <PageContainer size="lg" className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <IdentityBar />
          </div>
          <GlobalSearch />
        </PageContainer>
      </header>

      <PageContainer size="lg" className="min-w-0 flex-1 py-5 sm:py-8">
        {/* Brand — restrained, left-aligned, not a giant centered hero */}
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 shadow-lg shadow-blue-900/40">
            <span className="text-xl font-black leading-none text-white">P</span>
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Pitt Stop OS</h1>
            <p className="text-xs text-gray-500">Automotive operations</p>
          </div>
        </div>

        <div className="space-y-5 sm:space-y-8">
          {GROUP_ORDER.map((group) => {
            const items = visible.filter((m) => m.group === group)
            if (items.length === 0) return null
            return (
              <section key={group}>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">{group}</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {items.map((mod) => (
                    <ModuleRow key={mod.href} module={mod} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </PageContainer>

      <footer className="border-t border-gray-900/80">
        <PageContainer size="lg" className="py-5 text-center">
          <AdminLink className="text-sm text-gray-600 transition-colors hover:text-gray-400" />
        </PageContainer>
      </footer>
    </main>
  )
}

function ModuleRow({ module: mod }: { module: Module }) {
  return (
    <Link
      href={mod.href}
      className="group flex min-w-0 items-center gap-3 sm:gap-4 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3.5 transition-colors hover:border-gray-700 hover:bg-gray-900/70 active:bg-gray-800"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-800 text-gray-300 transition-colors group-hover:bg-gray-700 group-hover:text-white">
        <ModuleIcon icon={mod.icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words font-semibold text-white">{mod.label}</span>
        <span className="mt-1 block break-words text-xs leading-relaxed text-gray-400">{mod.sub}</span>
      </span>
      <svg
        className="shrink-0 text-gray-600 transition-colors group-hover:text-gray-400"
        width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Link>
  )
}

// Restrained, monochrome line icons — operational wayfinding, not decoration.
function ModuleIcon({ icon }: { icon: IconKey }): ReactNode {
  const p = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (icon) {
    case 'quick':
      return <svg {...p}><path d="M13 2 3 14h7l-1 8 10-12h-7z" /></svg>
    case 'dealer':
      return <svg {...p}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 3 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>
    case 'board':
      return <svg {...p}><rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="11" rx="1" /></svg>
    case 'auto':
      return <svg {...p}><path d="M5 17h14M6 17l1.5-5A2 2 0 0 1 9.4 11h5.2a2 2 0 0 1 1.9 1L18 17" /><circle cx="7.5" cy="17.5" r="1.5" /><circle cx="16.5" cy="17.5" r="1.5" /></svg>
    case 'receipt':
      return <svg {...p}><path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1z" /><path d="M9 8h6M9 12h6" /></svg>
    case 'estimate':
      return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h4" /></svg>
    case 'check':
      return <svg {...p}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 12h.01M18 12h.01" /><circle cx="12" cy="12" r="2" /></svg>
  }
}

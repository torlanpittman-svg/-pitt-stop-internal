import Link from 'next/link'
import IdentityBar, { AdminLink } from '@/app/components/IdentityBar'

// Retail Estimator is intentionally hidden from the homepage — its route/code/data are untouched.
const MODULES = [
  {
    href:    '/quick-entry',
    label:   'Quick Entry',
    sub:     'Customer + vehicle + services → Work Board in under a minute.',
  },
  {
    href:    '/dealer-check-in',
    label:   'Dealer Check-In',
    sub:     'Scan a tag → confirm → done. Invoice + Work Board, automatically.',
  },
  {
    href:    '/work-board',
    label:   'Work Board',
    sub:     'Live vehicle workflow — check in, track status, assign techs',
  },
  {
    href:     '/admin/auto-sales',
    label:    'Auto Sales Inventory',
    sub:      'Owned vehicles — scan a VIN, track costs, record the sale.',
    // Admin-gated via proxy.ts (/admin/*). Disable Link prefetch so Next.js doesn't background-hit
    // the auth gate and pop a Basic-Auth dialog on this public homepage. Auth is unchanged.
    prefetch: false as const,
  },
]

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">

      {/* Active employee identity (Phase 1) — renders nothing when IDENTITY_ENABLED is off */}
      <div className="px-6 pt-5"><IdentityBar /></div>

      <div className="px-6 pt-8 pb-10 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-600 rounded-2xl mb-4 shadow-lg shadow-blue-900/40">
          <span className="text-white font-black text-2xl leading-none">P</span>
        </div>
        <h1 className="text-3xl font-bold text-white tracking-tight">Pitt Stop OS</h1>
      </div>

      <div className="flex-1 px-6 space-y-4 pb-10">
        {MODULES.map(mod => (
          <Link
            key={mod.href}
            href={mod.href}
            prefetch={'prefetch' in mod ? mod.prefetch : undefined}
            className="block w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 hover:border-gray-700 active:bg-gray-800 transition-colors"
          >
            <h2 className="text-white font-bold text-xl mb-1">{mod.label}</h2>
            <p className="text-gray-500 text-sm mb-5">{mod.sub}</p>
            <div className="w-full bg-blue-600 text-white font-bold text-lg py-4 rounded-xl text-center">
              Open
            </div>
          </Link>
        ))}
      </div>

      <div className="px-6 pb-10 text-center">
        <AdminLink className="text-gray-600 hover:text-gray-400 text-sm transition-colors" />
      </div>

    </main>
  )
}

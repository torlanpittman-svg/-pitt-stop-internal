import Link from 'next/link'
import IdentityBar, { AdminLink } from '@/app/components/IdentityBar'

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
    href:    '/estimator',
    label:   'Retail Estimator',
    sub:     'Photograph a vehicle and create an estimate',
  },
  {
    href:    '/work-board',
    label:   'Work Board',
    sub:     'Live vehicle workflow — check in, track status, assign techs',
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

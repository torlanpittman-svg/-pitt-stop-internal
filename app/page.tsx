import Link from 'next/link'
import { APP_REGISTRY } from '@/apps/registry'

export default function Home() {
  const isPilotMode = process.env.PILOT_MODE === 'true'
  const active = APP_REGISTRY.filter((app) => app.enabled)
  const coming = APP_REGISTRY.filter((app) => !app.enabled)

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">

      {/* Header */}
      <div className="px-6 pt-14 pb-8 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-600 rounded-2xl mb-4 shadow-lg shadow-blue-900/40">
          <span className="text-white font-black text-2xl leading-none">P</span>
        </div>
        <h1 className="text-3xl font-bold text-white tracking-tight">Pitt Stop OS</h1>
        <p className="text-gray-500 mt-2 text-base">Choose your task</p>
      </div>

      {/* TEST MODE banner */}
      {isPilotMode && (
        <div className="mx-6 mb-6 bg-yellow-900/50 border border-yellow-700 rounded-2xl px-5 py-3 text-center">
          <p className="text-yellow-300 font-bold text-sm uppercase tracking-wide">TEST MODE</p>
          <p className="text-yellow-600 text-xs mt-0.5">Mock QuickBooks active — no real data will be sent</p>
        </div>
      )}

      {/* Module cards */}
      <div className="flex-1 px-6 space-y-4 pb-4">

        {active.map((app) => (
          <Link
            key={app.id}
            href={app.routes.main}
            className="block w-full bg-gray-900 border border-gray-800 rounded-2xl p-6 hover:border-gray-700 active:bg-gray-800 transition-colors"
          >
            <h2 className="text-white font-bold text-xl mb-1">{app.name}</h2>
            <p className="text-gray-500 text-sm mb-5">{app.description}</p>
            <div className="w-full bg-blue-600 text-white font-bold text-lg py-4 rounded-xl text-center">
              {app.buttonText ?? app.name}
            </div>
          </Link>
        ))}

        {coming.map((app) => (
          <div
            key={app.id}
            className="w-full bg-gray-900/40 border border-gray-800/50 rounded-2xl p-6 select-none"
          >
            <div className="flex items-start justify-between mb-1">
              <h2 className="text-gray-500 font-bold text-xl">{app.name}</h2>
              <span className="text-xs bg-gray-800 text-gray-600 rounded-full px-2.5 py-1 shrink-0 ml-3 mt-0.5">
                Coming Soon
              </span>
            </div>
            <p className="text-gray-700 text-sm mb-5">{app.description}</p>
            <div className="w-full bg-gray-800 text-gray-600 font-bold text-lg py-4 rounded-xl text-center cursor-not-allowed">
              {app.buttonText ?? app.name}
            </div>
          </div>
        ))}

      </div>

      {/* Admin link — small, less prominent */}
      <div className="px-6 py-10 text-center">
        <Link
          href="/admin"
          className="text-gray-600 hover:text-gray-400 text-sm transition-colors"
        >
          Admin
        </Link>
      </div>

    </main>
  )
}

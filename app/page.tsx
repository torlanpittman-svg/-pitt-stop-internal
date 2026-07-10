import Link from 'next/link'
import { APP_REGISTRY } from '@/apps/registry'

export default function Home() {
  const active = APP_REGISTRY.filter((app) => app.enabled)
  const coming = APP_REGISTRY.filter((app) => !app.enabled)

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-white tracking-tight">Pitt Stop</h1>
          <p className="text-gray-500 mt-2 text-lg">Internal Tools</p>
        </div>

        <div className="space-y-4">
          {active.map((app) => (
            <Link
              key={app.id}
              href={app.routes.main}
              className="flex items-center justify-between w-full bg-blue-600 active:bg-blue-700 rounded-2xl p-6 transition-colors"
            >
              <div>
                <div className="text-white font-bold text-xl">{app.name}</div>
                <div className="text-blue-200 text-sm mt-1">{app.description}</div>
              </div>
              <svg className="text-blue-300 w-6 h-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          ))}

          {coming.map((app) => (
            <div
              key={app.id}
              className="flex items-center justify-between w-full bg-gray-800 rounded-2xl p-6 opacity-40 select-none cursor-not-allowed"
            >
              <div>
                <div className="text-gray-400 font-bold text-xl">{app.name}</div>
                <div className="text-gray-600 text-sm mt-1">Coming soon</div>
              </div>
              <svg className="text-gray-600 w-6 h-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <Link href="/admin" className="text-gray-600 hover:text-gray-400 text-sm transition-colors">
            Admin →
          </Link>
        </div>
      </div>
    </main>
  )
}

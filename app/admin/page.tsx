import Link from 'next/link'
import { APP_REGISTRY } from '@/apps/registry'

export default function AdminPage() {
  const active = APP_REGISTRY.filter((app) => app.enabled)
  const coming = APP_REGISTRY.filter((app) => !app.enabled)

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold text-white mb-1">Admin Hub</h1>
      <p className="text-gray-500 mb-8">Internal review and management</p>

      {active.length > 0 && (
        <>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
            Active Apps
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-10">
            {active.map((app) => (
              <Link
                key={app.id}
                href={app.routes.admin}
                className="bg-gray-800 hover:bg-gray-700 rounded-xl p-6 border border-gray-700 hover:border-gray-600 transition-colors"
              >
                <h3 className="text-white font-semibold text-lg">{app.name}</h3>
                <p className="text-gray-500 text-sm mt-1">{app.description}</p>
              </Link>
            ))}
          </div>
        </>
      )}

      {coming.length > 0 && (
        <>
          <h2 className="text-xs font-semibold text-gray-600 uppercase tracking-widest mb-3">
            Coming Soon
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {coming.map((app) => (
              <div
                key={app.id}
                className="bg-gray-800 rounded-xl p-6 border border-gray-800 opacity-40 cursor-not-allowed select-none"
              >
                <h3 className="text-gray-400 font-semibold text-lg">{app.name}</h3>
                <p className="text-gray-600 text-sm mt-1">{app.description}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  )
}

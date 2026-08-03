export default function Loading() {
  return (
    <main className="min-h-screen bg-gray-950 px-5 pt-10 pb-16">
      <div className="max-w-2xl mx-auto">
        <div className="h-4 w-16 bg-gray-800 rounded animate-pulse" />
        <div className="h-7 w-56 bg-gray-800 rounded mt-4 animate-pulse" />
        <div className="h-3 w-72 bg-gray-900 rounded mt-3 animate-pulse" />
        <div className="mt-8 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-2xl bg-gray-900 border border-gray-800 p-4 animate-pulse">
              <div className="h-4 w-40 bg-gray-800 rounded" />
              <div className="h-3 w-24 bg-gray-800 rounded mt-3" />
            </div>
          ))}
        </div>
        <p className="text-gray-600 text-sm text-center mt-6">Loading catalog…</p>
      </div>
    </main>
  )
}

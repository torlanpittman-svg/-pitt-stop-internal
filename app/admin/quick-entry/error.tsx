'use client'

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="min-h-screen bg-gray-950 px-5 pt-10 pb-16 flex flex-col items-center justify-center text-center">
      <div className="max-w-sm">
        <p className="text-4xl mb-3">⚠️</p>
        <h1 className="text-white text-lg font-bold">Couldn’t load the catalog</h1>
        <p className="text-gray-500 text-sm mt-2">A read-only error occurred while loading the Quick Entry catalog. Nothing was changed.</p>
        <button onClick={reset} className="mt-5 px-5 py-2.5 rounded-2xl bg-white text-black font-semibold text-sm">Try again</button>
      </div>
    </main>
  )
}

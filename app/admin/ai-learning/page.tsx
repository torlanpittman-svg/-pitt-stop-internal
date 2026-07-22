import Link from 'next/link'

export default function AiLearningHubPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm transition-colors mb-8"
      >
        <span>←</span>
        <span>Back to Admin</span>
      </Link>

      <h1 className="text-2xl font-bold text-white mb-1">AI Learning</h1>
      <p className="text-gray-500 text-sm mb-8">
        Ground-truth data collected from both modules. Employee corrections become
        permanent training signals — original AI predictions are never overwritten.
      </p>

      {/* How it works */}
      <div className="bg-blue-950/30 border border-blue-800/50 rounded-2xl px-5 py-4 mb-8 text-sm space-y-1.5">
        <p className="text-blue-300 font-semibold text-xs uppercase tracking-widest mb-2">How it works</p>
        <p className="text-gray-400">
          Every key-tag scan and every approved estimate is stored with two sets of values:
          the <span className="text-white">original AI prediction</span> (frozen at creation) and the{' '}
          <span className="text-white">employee-confirmed final value</span>.
        </p>
        <p className="text-gray-400">
          Corrections never overwrite the original — they are recorded separately.
          This produces an ever-growing labeled dataset that can be used to measure accuracy,
          identify failure patterns, and test improved prompts without changing ground truth.
        </p>
      </div>

      {/* Module cards */}
      <div className="space-y-4">

        {/* Dealer Tag Scanner */}
        <Link
          href="/admin/ai-learning/dealer-tags"
          className="block bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-2xl px-6 py-5 group transition-colors"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-widest">Module 1</span>
              </div>
              <h2 className="text-white font-bold text-lg group-hover:text-blue-300 transition-colors">
                Dealer Tag Scanner Learning
              </h2>
              <p className="text-gray-500 text-sm mt-1">
                Key-tag OCR accuracy · per-field corrections · stock-number normalization ·
                character substitution patterns · saved-photo replay tool
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {['Year', 'Make', 'Model', 'Color', 'Stock #', 'Prefix'].map(f => (
                  <span key={f} className="text-xs bg-gray-800 text-gray-400 rounded-full px-2.5 py-0.5">{f}</span>
                ))}
              </div>
            </div>
            <span className="text-gray-600 group-hover:text-gray-300 transition-colors text-2xl mt-1">›</span>
          </div>
        </Link>

        {/* Retail Estimator */}
        <Link
          href="/admin/ai-learning/estimator"
          className="block bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-2xl px-6 py-5 group transition-colors"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-purple-400 uppercase tracking-widest">Module 2</span>
              </div>
              <h2 className="text-white font-bold text-lg group-hover:text-purple-300 transition-colors">
                Retail Estimator Learning
              </h2>
              <p className="text-gray-500 text-sm mt-1">
                Pricing accuracy · adjustment rates · by-service breakdown ·
                line-item snapshots at approval time
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {['AI Price', 'Approved Price', 'Delta', 'Service Focus', 'Line Items'].map(f => (
                  <span key={f} className="text-xs bg-gray-800 text-gray-400 rounded-full px-2.5 py-0.5">{f}</span>
                ))}
              </div>
            </div>
            <span className="text-gray-600 group-hover:text-gray-300 transition-colors text-2xl mt-1">›</span>
          </div>
        </Link>

      </div>

      {/* Framework guarantee */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Original predictions never overwritten', icon: '🔒' },
          { label: 'Ground truth set by employee, not AI', icon: '✓' },
          { label: 'Replay saved photos against new prompts', icon: '↺' },
        ].map(({ label, icon }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-3">
            <span className="text-lg">{icon}</span>
            <span className="text-gray-400 text-xs">{label}</span>
          </div>
        ))}
      </div>
    </main>
  )
}

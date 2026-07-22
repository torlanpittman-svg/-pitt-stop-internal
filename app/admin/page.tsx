import Link from 'next/link'

type AdminLink = {
  label: string
  description: string
  href: string
}

type AdminSection = {
  group: string
  links: AdminLink[]
}

const ADMIN_SECTIONS: AdminSection[] = [
  {
    group: 'Dealer Vehicle Entry',
    links: [
      {
        label: 'Vehicle Entries',
        description: 'All scanned key tags and their current status',
        href: '/admin/vehicle-entry',
      },
      {
        label: 'Dealer Batches',
        description: 'Active and completed QuickBooks invoice batches',
        href: '/admin/vehicle-entry/invoices',
      },
      {
        label: 'Pilot Dashboard',
        description: 'Scan volume, corrections, and accuracy for the pilot program',
        href: '/admin/vehicle-entry/pilot',
      },
      {
        label: 'Dealership Management',
        description: 'Add and configure dealership accounts',
        href: '/admin/vehicle-entry/dealerships',
      },
    ],
  },
  {
    group: 'Retail Estimator',
    links: [
      {
        label: 'Estimator Admin',
        description: 'Estimate review and configuration — coming soon',
        href: '#',
      },
    ],
  },
]

export default function AdminPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-10">

      {/* Back to Pitt Stop OS */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm transition-colors mb-8"
      >
        <span>←</span>
        <span>Back to Pitt Stop OS</span>
      </Link>

      <h1 className="text-2xl font-bold text-white mb-1">Admin</h1>
      <p className="text-gray-500 text-sm mb-10">Internal operations and management</p>

      {/* ── AI LEARNING ───────────────────────────────────────────────── */}
      <div className="mb-10">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
          AI Learning
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

          <Link
            href="/admin/ai-learning/dealer-tags"
            className="block bg-gray-900 border border-gray-800 hover:border-blue-700 rounded-2xl px-5 py-4 group transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-blue-400 text-xs font-semibold uppercase tracking-widest mb-1">Module 1</p>
                <p className="text-white font-semibold text-sm group-hover:text-blue-300 transition-colors">
                  Dealer Tag Scanner Learning
                </p>
                <p className="text-gray-500 text-xs mt-1">
                  OCR accuracy · corrections · normalization · replay tool
                </p>
              </div>
              <span className="text-gray-600 group-hover:text-gray-300 transition-colors text-lg shrink-0 mt-0.5">›</span>
            </div>
          </Link>

          <Link
            href="/admin/ai-learning/estimator"
            className="block bg-gray-900 border border-gray-800 hover:border-purple-700 rounded-2xl px-5 py-4 group transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-purple-400 text-xs font-semibold uppercase tracking-widest mb-1">Module 2</p>
                <p className="text-white font-semibold text-sm group-hover:text-purple-300 transition-colors">
                  Retail Estimator Learning
                </p>
                <p className="text-gray-500 text-xs mt-1">
                  Pricing accuracy · adjustments · by-service breakdown
                </p>
              </div>
              <span className="text-gray-600 group-hover:text-gray-300 transition-colors text-lg shrink-0 mt-0.5">›</span>
            </div>
          </Link>

        </div>
      </div>

      {/* ── OTHER SECTIONS ────────────────────────────────────────────── */}
      <div className="space-y-10">
        {ADMIN_SECTIONS.map((section) => (
          <div key={section.group}>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
              {section.group}
            </h2>
            <div className="bg-gray-900 rounded-2xl overflow-hidden divide-y divide-gray-800">
              {section.links.map((link) => {
                const isDisabled = link.href === '#'
                if (isDisabled) {
                  return (
                    <div
                      key={link.label}
                      className="flex items-center justify-between px-5 py-4 opacity-40 select-none"
                    >
                      <div>
                        <p className="text-gray-400 font-medium text-sm">{link.label}</p>
                        <p className="text-gray-600 text-xs mt-0.5">{link.description}</p>
                      </div>
                      <span className="text-gray-700 text-xs">Coming Soon</span>
                    </div>
                  )
                }
                return (
                  <Link
                    key={link.label}
                    href={link.href}
                    className="flex items-center justify-between px-5 py-4 hover:bg-gray-800 transition-colors group"
                  >
                    <div>
                      <p className="text-white font-medium text-sm">{link.label}</p>
                      <p className="text-gray-500 text-xs mt-0.5">{link.description}</p>
                    </div>
                    <span className="text-gray-600 group-hover:text-gray-300 transition-colors text-lg ml-4">›</span>
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </div>

    </main>
  )
}

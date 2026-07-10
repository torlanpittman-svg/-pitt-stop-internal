import Link from 'next/link'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-2 text-sm">
          <Link href="/" className="text-gray-500 hover:text-white transition-colors">
            Pitt Stop
          </Link>
          <span className="text-gray-700">›</span>
          <span className="text-gray-300 font-medium">Admin</span>
        </div>
      </header>
      {children}
    </div>
  )
}

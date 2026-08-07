import NavHeader from '@/app/components/NavHeader'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950">
      <NavHeader title="Admin" />
      {children}
    </div>
  )
}

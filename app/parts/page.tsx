import { notFound } from 'next/navigation'
import { PageContainer } from '@/app/components/ui/PageHeader'
import { employeeAuthorized, authorizedManager } from '@/apps/auth/employee-guard'
import { partsVisibleFor, partsScreenshotImportEnabled } from '@/apps/parts/visibility'
import PartsLanding from './PartsLanding'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Standalone Parts page — the quickest phone path to look up parts (opens PartsTech in another tab). Gated
 * BOTH on a valid shop session (employeeAuthorized) AND the existing parts visibility (managers always;
 * employees only when PARTS_EMPLOYEE_VISIBLE is on) so an unauthenticated viewer never reaches it.
 * `authorizedManager()` provides the same dev-open parity used by the other shop surfaces (no new bypass).
 */
export default async function PartsPage() {
  if (!(await employeeAuthorized())) notFound()
  const manager = !!(await authorizedManager())
  if (!partsVisibleFor(manager)) notFound()

  return (
    <main className="flex min-h-screen flex-col bg-gray-950">
      <header className="border-b border-gray-900/80">
        <PageContainer size="md" className="flex items-center py-3">
          <h1 className="text-base font-semibold text-white">Parts</h1>
        </PageContainer>
      </header>
      <PageContainer size="md" className="flex-1 py-6">
        <PartsLanding importEnabled={partsScreenshotImportEnabled()} />
      </PageContainer>
    </main>
  )
}

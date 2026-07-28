import { getConnectionStatus } from '@/apps/quickbooks/connection'
import { configDiagnostics } from '@/apps/quickbooks/config'
import QuickBooksClient from './QuickBooksClient'

export const dynamic = 'force-dynamic'

export default async function QuickBooksIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; realm?: string }>
}) {
  const params = await searchParams
  const [status, config] = await Promise.all([
    getConnectionStatus(),
    Promise.resolve(configDiagnostics()),
  ])

  return (
    <QuickBooksClient
      initialStatus={status}
      initialConfig={config}
      banner={{
        connected: params.connected === '1',
        error:     params.error,
        realm:     params.realm,
      }}
    />
  )
}

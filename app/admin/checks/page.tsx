/**
 * /admin/checks — OWNER setup + history for Write-a-Check (admin-gated by proxy ADMIN_PASSWORD).
 * All data is loaded client-side from the admin API so bank/expense accounts are always picked from the
 * live QuickBooks company. This page never contains bank credentials or account numbers.
 */
import ChecksAdmin from './ChecksAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default function ChecksAdminPage() {
  return <ChecksAdmin />
}

import DealerCheckInFlow from './DealerCheckInFlow'
import { authorizedManagerStrict } from '@/apps/auth/employee-guard'

export const dynamic = 'force-dynamic'

export default async function DealerCheckInPage() {
  // "+ Add New Dealer" is offered to managers only (the API enforces the same gate).
  const canManageDealers = !!(await authorizedManagerStrict())
  return <DealerCheckInFlow canManageDealers={canManageDealers} />
}

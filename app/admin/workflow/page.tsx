import { listEmployees } from '@/apps/workflow/db'
import EmployeeAdmin from './EmployeeAdmin'

export const dynamic = 'force-dynamic'

export default async function WorkflowAdminPage() {
  const employees = await listEmployees()
  return <EmployeeAdmin initialEmployees={employees} />
}

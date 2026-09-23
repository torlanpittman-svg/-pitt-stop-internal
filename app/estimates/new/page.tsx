import { redirect } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { estimateEnabled } from '@/apps/workflow/estimate'
import QuickEntryFlow from '@/app/quick-entry/QuickEntryFlow'

export const dynamic = 'force-dynamic'
export default async function NewEstimatePage() {
  if (!await managerActor() || !estimateEnabled()) redirect('/')
  return <QuickEntryFlow mode="estimate" />
}

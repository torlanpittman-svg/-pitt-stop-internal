import { listActiveOrders } from '@/apps/workflow/db'
import WorkBoardClient from './WorkBoardClient'

export const dynamic = 'force-dynamic'

export default async function WorkBoardPage() {
  const initialOrders = await listActiveOrders()
  return <WorkBoardClient initialOrders={initialOrders} />
}

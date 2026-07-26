import { listActiveOrders } from '@/apps/workflow/db'
import WorkBoardClient from './WorkBoardClient'

export const dynamic = 'force-dynamic'

export default async function WorkBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>
}) {
  const [initialOrders, { new: newOrderId }] = await Promise.all([
    listActiveOrders(),
    searchParams,
  ])
  return <WorkBoardClient initialOrders={initialOrders} newOrderId={newOrderId} />
}

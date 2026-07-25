import { getOrderWithContext } from '@/apps/workflow/db'
import { notFound } from 'next/navigation'
import OrderDetail from './OrderDetail'

export const dynamic = 'force-dynamic'

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = await getOrderWithContext(id)
  if (!order) notFound()
  return <OrderDetail initialOrder={order} />
}

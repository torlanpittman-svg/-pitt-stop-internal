import { getOrderWithContext } from '@/apps/workflow/db'
import { getOrderRetailWorkValueCents } from '@/apps/workflow/production'
import { orderSourceKind } from '@/apps/workflow/fees'
import { notFound } from 'next/navigation'
import OrderDetail from './OrderDetail'

export const dynamic = 'force-dynamic'

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = await getOrderWithContext(id)
  if (!order) notFound()
  // Retail-only, view-only work value (canonical precedence). Dealer/unknown → not shown here.
  const workValueCents = orderSourceKind(order) === 'retail' ? await getOrderRetailWorkValueCents(id) : null
  return <OrderDetail initialOrder={order} workValueCents={workValueCents} />
}

import { notFound } from 'next/navigation'
import { getVehicleEntry } from '@/apps/vehicle-entry/db'
import ConfirmForm from './ConfirmForm'

export const dynamic = 'force-dynamic'

export default async function ConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ mode?: string }>
}) {
  const [{ id }, { mode }] = await Promise.all([params, searchParams])
  const entry = await getVehicleEntry(id)

  if (!entry) return notFound()

  // Manual entries start in edit mode so the employee fills in all fields
  return <ConfirmForm entry={entry} startInEditMode={mode === 'manual'} />
}

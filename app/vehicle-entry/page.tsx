import CaptureView from './CaptureView'

export default async function VehicleEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string }>
}) {
  const sp = await searchParams
  const showSuccess = sp.success === '1'
  const isDemoMode = !process.env.DATABASE_URL || !process.env.OPENAI_API_KEY

  return <CaptureView showSuccess={showSuccess} isDemoMode={isDemoMode} />
}

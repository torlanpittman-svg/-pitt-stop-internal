import PhotoCapture from './PhotoCapture'

export default async function PhotosPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <PhotoCapture estimateId={id} />
}

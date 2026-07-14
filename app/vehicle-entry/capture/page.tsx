import CaptureView from '../CaptureView'

export default async function CapturePage() {
  const isDemoMode  = !process.env.DATABASE_URL || !process.env.OPENAI_API_KEY
  const isPilotMode = process.env.PILOT_MODE === 'true'
  return <CaptureView isDemoMode={isDemoMode} isPilotMode={isPilotMode} />
}

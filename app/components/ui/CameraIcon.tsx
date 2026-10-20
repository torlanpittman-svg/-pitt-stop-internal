/** The app's camera icon (stroke, currentColor) — shared by Vehicle photos and Scan VIN. */
export default function CameraIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 5l2-2h4l2 2h3a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  )
}

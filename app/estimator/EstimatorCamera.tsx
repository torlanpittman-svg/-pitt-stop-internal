'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { PhotoOrientation } from '@/apps/estimator/photo-steps'

const MAX_SIDE = 1280  // GPT-4o high-detail tile is 1024px; anything beyond adds cost, not accuracy

function canvasToBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob(
      b => (b ? resolve(b) : reject(new Error('canvas export failed'))),
      type,
      quality
    )
  )
}

function resizedCanvas(srcWidth: number, srcHeight: number): HTMLCanvasElement {
  const scale  = Math.min(1, MAX_SIDE / Math.max(srcWidth, srcHeight))
  const canvas = document.createElement('canvas')
  canvas.width  = Math.round(srcWidth  * scale)
  canvas.height = Math.round(srcHeight * scale)
  return canvas
}

function FrameGuide({ orientation }: { orientation: PhotoOrientation }) {
  const corner = 'absolute w-8 h-8'

  if (orientation === 'landscape') {
    return (
      <div className="absolute inset-x-4 top-[18%] bottom-[18%] pointer-events-none">
        <div className={`${corner} top-0 left-0 border-t-2 border-l-2 border-white/70`} />
        <div className={`${corner} top-0 right-0 border-t-2 border-r-2 border-white/70`} />
        <div className={`${corner} bottom-0 left-0 border-b-2 border-l-2 border-white/70`} />
        <div className={`${corner} bottom-0 right-0 border-b-2 border-r-2 border-white/70`} />
      </div>
    )
  }

  if (orientation === 'close-up') {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="relative w-52 h-52">
          <div className={`${corner} top-0 left-0 border-t-2 border-l-2 border-white/70`} />
          <div className={`${corner} top-0 right-0 border-t-2 border-r-2 border-white/70`} />
          <div className={`${corner} bottom-0 left-0 border-b-2 border-l-2 border-white/70`} />
          <div className={`${corner} bottom-0 right-0 border-b-2 border-r-2 border-white/70`} />
        </div>
      </div>
    )
  }

  // portrait — subtle tall guide
  return (
    <div className="absolute inset-x-8 top-10 bottom-32 pointer-events-none">
      <div className={`${corner} top-0 left-0 border-t-2 border-l-2 border-white/40`} />
      <div className={`${corner} top-0 right-0 border-t-2 border-r-2 border-white/40`} />
      <div className={`${corner} bottom-0 left-0 border-b-2 border-l-2 border-white/40`} />
      <div className={`${corner} bottom-0 right-0 border-b-2 border-r-2 border-white/40`} />
    </div>
  )
}

export default function EstimatorCamera({
  stepLabel,
  stepHint,
  orientation = 'portrait',
  onCapture,
}: {
  stepLabel:    string
  stepHint:     string
  orientation?: PhotoOrientation
  onCapture:    (file: File) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef     = useRef<HTMLVideoElement>(null)

  const [ready,       setReady]       = useState(false)
  const [camFailed,   setCamFailed]   = useState(false)
  const [capturing,   setCapturing]   = useState(false)
  const [isLandscape, setIsLandscape] = useState(false)

  useEffect(() => {
    const check = () => setIsLandscape(window.innerWidth > window.innerHeight)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    let stream: MediaStream | null = null
    let live = true

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unavailable')
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        })
        if (!live) { stream.getTracks().forEach(t => t.stop()); return }
        const v = videoRef.current!
        v.srcObject = stream
        await v.play()
        if (live) setReady(true)
      } catch {
        if (live) setCamFailed(true)
      }
    }

    start()
    return () => { live = false; stream?.getTracks().forEach(t => t.stop()) }
  }, [])

  const captureFromCamera = useCallback(async () => {
    const video = videoRef.current
    if (!video || capturing) return
    setCapturing(true)

    try {
      const canvas = resizedCanvas(video.videoWidth, video.videoHeight)
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.82)
      const ts = Date.now()
      onCapture(new File([blob], `estimator-${ts}.jpg`, { type: 'image/jpeg' }))
    } catch {
      setCapturing(false)
    }
  }, [capturing, onCapture])

  const needsRotation = orientation === 'landscape' && !isLandscape

  // Camera unavailable (e.g. desktop) — the shared Upload path is provided by
  // PhotoInput below.
  if (camFailed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div>
          <p className="text-white font-bold text-lg mb-1">{stepLabel}</p>
          <p className="text-gray-400 text-sm">{stepHint}</p>
        </div>
        <p className="text-yellow-400 text-sm">Camera unavailable — use <span className="font-semibold">Upload from library</span> below.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Viewfinder */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden bg-black min-h-0">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-white/40 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Rotate-phone prompt for landscape shots */}
        {ready && needsRotation && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center z-20 pointer-events-none gap-5">
            {/* Phone-rotate icon */}
            <svg
              width="72"
              height="72"
              viewBox="0 0 72 72"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-white"
            >
              {/* Phone body in portrait */}
              <rect x="24" y="8" width="24" height="40" rx="4" stroke="currentColor" strokeWidth="2.5" />
              <circle cx="36" cy="43" r="2" fill="currentColor" />
              {/* Rotation arrow */}
              <path
                d="M12 36 C12 20 24 10 36 10"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M32 6 L36 10 L32 14"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            <div className="text-center px-8">
              <p className="text-white text-xl font-bold">Turn phone sideways</p>
              <p className="text-gray-400 text-sm mt-2">
                Fit the full length of the vehicle inside the frame
              </p>
            </div>
          </div>
        )}

        {/* Frame guide overlay */}
        {ready && !needsRotation && <FrameGuide orientation={orientation} />}

        {/* Hint pill */}
        {ready && !needsRotation && (
          <div className="absolute bottom-4 inset-x-0 flex justify-center pointer-events-none">
            <div className="bg-black/60 text-white text-sm px-4 py-2 rounded-full text-center max-w-xs">
              {stepHint}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-black shrink-0 flex flex-col items-center gap-3 pt-5 pb-7">
        <button
          onClick={captureFromCamera}
          disabled={!ready || capturing || needsRotation}
          aria-label="Take photo"
          className="w-20 h-20 rounded-full border-[4px] border-white/80 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
        >
          {capturing
            ? <div className="w-8 h-8 border-[3px] border-white border-t-transparent rounded-full animate-spin" />
            : <div className="w-[3.25rem] h-[3.25rem] rounded-full bg-white" />
          }
        </button>
        {/* Shared Upload path ("Upload from library") is provided by PhotoInput. */}
      </div>
    </div>
  )
}

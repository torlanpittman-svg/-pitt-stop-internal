'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

function canvasToBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob(
      b => (b ? resolve(b) : reject(new Error('canvas export failed'))),
      type,
      quality
    )
  )
}

export default function EstimatorCamera({
  stepLabel,
  stepHint,
  onCapture,
}: {
  stepLabel: string
  stepHint:  string
  onCapture: (file: File) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef     = useRef<HTMLVideoElement>(null)

  const [ready,     setReady]     = useState(false)
  const [camFailed, setCamFailed] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [fileKey,   setFileKey]   = useState(0)

  useEffect(() => {
    let stream: MediaStream | null = null
    let live = true

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unavailable')
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 3840 },
            height: { ideal: 2160 },
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
      const vw = video.videoWidth
      const vh = video.videoHeight
      const canvas = document.createElement('canvas')
      canvas.width  = vw
      canvas.height = vh
      canvas.getContext('2d')!.drawImage(video, 0, 0)
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.90)
      const ts = Date.now()
      onCapture(new File([blob], `estimator-${ts}.jpg`, { type: 'image/jpeg' }))
    } catch {
      setCapturing(false)
    }
  }, [capturing, onCapture])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFileKey(k => k + 1)
    onCapture(f)
  }, [onCapture])

  if (camFailed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6">
        <div className="text-center">
          <p className="text-white font-bold text-lg mb-1">{stepLabel}</p>
          <p className="text-gray-400 text-sm">{stepHint}</p>
        </div>
        <div className="relative w-full max-w-sm">
          <div className="bg-blue-600 rounded-2xl py-5 text-center text-white font-bold text-lg pointer-events-none select-none">
            Upload Photo
          </div>
          <input
            key={fileKey}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>
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

        {ready && (
          <div className="absolute bottom-4 inset-x-0 flex justify-center pointer-events-none">
            <div className="bg-black/60 text-white text-sm px-4 py-2 rounded-full">
              {stepHint}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-black shrink-0 flex flex-col items-center gap-3 pt-5 pb-7">
        <button
          onClick={captureFromCamera}
          disabled={!ready || capturing}
          aria-label="Take photo"
          className="w-20 h-20 rounded-full border-[4px] border-white/80 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
        >
          {capturing
            ? <div className="w-8 h-8 border-[3px] border-white border-t-transparent rounded-full animate-spin" />
            : <div className="w-[3.25rem] h-[3.25rem] rounded-full bg-white" />
          }
        </button>

        <div className="relative">
          <span className="text-gray-500 text-sm underline cursor-pointer">
            Upload from library
          </span>
          <input
            key={fileKey}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>
      </div>
    </div>
  )
}

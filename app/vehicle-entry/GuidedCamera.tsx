'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// Key tag aspect ratio (width ÷ height) for vertical/portrait orientation
const TAG_ASPECT  = 0.5   // 1 : 2  (taller than wide)
// Analysis canvas width — small so the quality loop stays cheap
const ANALYZE_W   = 80

// Quality thresholds (starting values — tune after field testing)
const BLUR_THRESH  = 3.5   // mean absolute Laplacian; below = blurry
const DARK_THRESH  = 55    // mean luminance 0–255; below = too dark
const GLARE_THRESH = 0.12  // fraction of pixels above 238 brightness

type Issue = 'blur' | 'dark' | 'glare'

const ISSUE_LABEL: Record<Issue, string> = {
  blur:  'Hold still — image is blurry',
  dark:  'Too dark — move to better lighting',
  glare: 'Glare — angle the tag slightly',
}

function canvasToBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob(
      b => (b ? resolve(b) : reject(new Error('canvas export failed'))),
      type,
      quality
    )
  )
}

export default function GuidedCamera({
  onCapture,
}: {
  /**
   * Called with the primary image (cropped to guide frame) and the full
   * original frame. For file uploads, original is null.
   */
  onCapture: (primary: File, original: File | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef     = useRef<HTMLVideoElement>(null)
  const guideRef     = useRef<HTMLDivElement>(null)

  const [ready,      setReady]      = useState(false)
  const [camFailed,  setCamFailed]  = useState(false)
  const [issues,     setIssues]     = useState<Issue[]>([])
  const [capturing,  setCapturing]  = useState(false)

  // ── Camera start ───────────────────────────────────────────────────────────
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

  // ── Quality analysis loop (500 ms) ─────────────────────────────────────────
  useEffect(() => {
    if (!ready) return
    const canvas = document.createElement('canvas')

    const id = setInterval(() => {
      const video     = videoRef.current
      const guide     = guideRef.current
      const container = containerRef.current
      if (!video || !guide || !container || video.readyState < 2) return

      // Guide frame rect relative to the video container
      const vr = container.getBoundingClientRect()
      const gr = guide.getBoundingClientRect()
      const fx = gr.left - vr.left
      const fy = gr.top  - vr.top
      const fw = gr.width
      const fh = gr.height

      // Map display coords → actual video pixel coords (object-fit: cover)
      const dw = vr.width, dh = vr.height
      const vw = video.videoWidth, vh = video.videoHeight
      if (!vw || !vh) return
      const cs  = Math.max(dw / vw, dh / vh)   // cover scale
      const ox  = (vw * cs - dw) / 2 / cs       // letterbox offset X in video px
      const oy  = (vh * cs - dh) / 2 / cs       // letterbox offset Y in video px

      // Draw only the frame region at reduced size
      const aw = ANALYZE_W
      const ah = Math.max(1, Math.round(aw / TAG_ASPECT))
      canvas.width = aw; canvas.height = ah
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, fx / cs + ox, fy / cs + oy, fw / cs, fh / cs, 0, 0, aw, ah)

      const { data: px } = ctx.getImageData(0, 0, aw, ah)
      const N = aw * ah

      // Brightness + glare pass
      let bright = 0, glareCount = 0
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
        bright += lum
        if (lum > 238) glareCount++
      }
      bright /= N

      // Sharpness via discrete Laplacian (measures edge strength)
      let lap = 0, lapN = 0
      for (let y = 1; y < ah - 1; y++) {
        for (let x = 1; x < aw - 1; x++) {
          const i = (y * aw + x) * 4
          const c = (px[i]        + px[i + 1]          + px[i + 2])          / 3
          const l = (px[i - 4]    + px[i - 3]          + px[i - 2])          / 3
          const r = (px[i + 4]    + px[i + 5]          + px[i + 6])          / 3
          const t = (px[i-aw*4]   + px[i - aw * 4 + 1] + px[i - aw * 4 + 2]) / 3
          const b = (px[i + aw*4] + px[i + aw * 4 + 1] + px[i + aw * 4 + 2]) / 3
          lap += Math.abs(4 * c - l - r - t - b)
          lapN++
        }
      }
      const sharpness = lapN > 0 ? lap / lapN : 0

      const found: Issue[] = []
      if (sharpness < BLUR_THRESH)        found.push('blur')
      if (bright < DARK_THRESH)           found.push('dark')
      if (glareCount / N > GLARE_THRESH)  found.push('glare')
      setIssues(found)
    }, 500)

    return () => clearInterval(id)
  }, [ready])

  // ── Capture from live camera ───────────────────────────────────────────────
  const captureFromCamera = useCallback(async () => {
    const video     = videoRef.current
    const guide     = guideRef.current
    const container = containerRef.current
    if (!video || !guide || !container || capturing) return
    setCapturing(true)

    try {
      // Map guide frame to actual video pixel coords
      const vr  = container.getBoundingClientRect()
      const gr  = guide.getBoundingClientRect()
      const fx  = gr.left - vr.left
      const fy  = gr.top  - vr.top
      const fw  = gr.width
      const fh  = gr.height
      const dw  = vr.width, dh = vr.height
      const vw  = video.videoWidth, vh = video.videoHeight
      const cs  = Math.max(dw / vw, dh / vh)
      const ox  = (vw * cs - dw) / 2 / cs
      const oy  = (vh * cs - dh) / 2 / cs
      const srcX = Math.max(0, fx / cs + ox)
      const srcY = Math.max(0, fy / cs + oy)
      const srcW = Math.min(fw / cs, vw - srcX)
      const srcH = Math.min(fh / cs, vh - srcY)

      // Full original frame
      const origCanvas = document.createElement('canvas')
      origCanvas.width  = vw
      origCanvas.height = vh
      origCanvas.getContext('2d')!.drawImage(video, 0, 0)

      // Cropped frame
      const cropCanvas = document.createElement('canvas')
      cropCanvas.width  = Math.round(srcW)
      cropCanvas.height = Math.round(srcH)
      cropCanvas.getContext('2d')!.drawImage(
        origCanvas, srcX, srcY, srcW, srcH,
        0, 0, cropCanvas.width, cropCanvas.height
      )

      const [croppedBlob, originalBlob] = await Promise.all([
        canvasToBlob(cropCanvas, 'image/jpeg', 0.95),
        canvasToBlob(origCanvas, 'image/jpeg', 0.90),
      ])

      const ts = Date.now()
      onCapture(
        new File([croppedBlob],  `keytag-crop-${ts}.jpg`, { type: 'image/jpeg' }),
        new File([originalBlob], `keytag-orig-${ts}.jpg`, { type: 'image/jpeg' }),
      )
    } catch {
      setCapturing(false)
    }
  }, [capturing, onCapture])

  // ── Camera unavailable (e.g. desktop) — upload is provided by PhotoInput ────
  if (camFailed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-4xl">📷</span>
        <p className="text-yellow-400 text-sm">
          Camera unavailable on this device — use <span className="font-semibold">Upload existing photo</span> below.
        </p>
      </div>
    )
  }

  const frameBorder = issues.length === 0
    ? 'rgba(255,255,255,0.92)'
    : 'rgba(250,204,21,0.9)'

  // ── Main viewfinder UI ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0">

      {/* Viewfinder */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden bg-black min-h-0">

        {/* Camera stream */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />

        {/* Loading spinner */}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-white/40 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {ready && (
          <>
            {/* Guide frame — box-shadow darkens outside, border marks the frame */}
            <div
              ref={guideRef}
              className="absolute"
              style={{
                width:       '52%',
                maxWidth:    '260px',
                left:        '50%',
                top:         '50%',
                transform:   'translate(-50%, -52%)',
                aspectRatio: '1 / 2',
                boxShadow:   '0 0 0 9999px rgba(0,0,0,0.52)',
                border:      `2.5px solid ${frameBorder}`,
                borderRadius: '10px',
                transition:  'border-color 0.2s',
              }}
            >
              {/* L-shaped corner accents */}
              {([
                { top: -2, left:  -2, borderTop:    '3px solid white', borderLeft:  '3px solid white', borderRadius: '7px 0 0 0' },
                { top: -2, right: -2, borderTop:    '3px solid white', borderRight: '3px solid white', borderRadius: '0 7px 0 0' },
                { bottom: -2, left:  -2, borderBottom: '3px solid white', borderLeft:  '3px solid white', borderRadius: '0 0 0 7px' },
                { bottom: -2, right: -2, borderBottom: '3px solid white', borderRight: '3px solid white', borderRadius: '0 0 7px 0' },
              ] as React.CSSProperties[]).map((style, i) => (
                <div key={i} className="absolute w-7 h-7" style={style} />
              ))}
            </div>

            {/* Top instruction */}
            <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none">
              <span className="bg-black/60 text-white text-xs px-3 py-1.5 rounded-full">
                Hold the key tag vertically and fit the entire tag inside the frame.
              </span>
            </div>

            {/* Quality status — bottom of viewfinder */}
            <div className="absolute bottom-4 inset-x-0 flex flex-col items-center gap-1.5 pointer-events-none">
              {issues.map(issue => (
                <div
                  key={issue}
                  className="bg-black/75 text-yellow-300 text-sm px-4 py-1.5 rounded-full"
                >
                  ⚠ {ISSUE_LABEL[issue]}
                </div>
              ))}
              {issues.length === 0 && (
                <div className="text-green-400/80 text-sm font-medium">● Ready</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Controls */}
      <div className="bg-black shrink-0 flex flex-col items-center gap-3 pt-5 pb-7">

        {/* Shutter button */}
        <button
          onClick={captureFromCamera}
          disabled={!ready || capturing}
          aria-label="Capture photo"
          className="w-20 h-20 rounded-full border-[4px] border-white/80 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
        >
          {capturing
            ? <div className="w-8 h-8 border-[3px] border-white border-t-transparent rounded-full animate-spin" />
            : <div className="w-[3.25rem] h-[3.25rem] rounded-full bg-white" />
          }
        </button>

        {/* For best results hint — the shared Upload path is rendered by PhotoInput. */}
        <p className="text-gray-500 text-xs text-center px-8">
          For best results, take a new photo with the tag straight and centered.
        </p>
      </div>
    </div>
  )
}

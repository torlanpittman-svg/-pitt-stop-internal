'use client'

import { useEffect, useRef, useState } from 'react'
import { normalizeImage } from './PhotoInput'
import { MAX_PHOTO_BYTES, MAX_SOURCE_BYTES, type OrderPhoto } from '@/apps/order-photos/types'

const button = 'rounded-xl border border-gray-700 bg-gray-800 px-3 py-3 text-sm font-semibold text-white disabled:opacity-40'

async function responseData(response: Response) {
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not save. Check your connection and try again.')
  return data
}

export default function OrderPhotos({ orderId }: { orderId: string }) {
  const [photos, setPhotos] = useState<OrderPhoto[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<File[]>([])
  const lock = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const base = `/api/workflow/orders/${orderId}/photos`

  useEffect(() => {
    let active = true
    fetch(base, { cache: 'no-store' }).then(responseData).then((data) => {
      if (!Array.isArray(data.photos)) throw new Error('Could not load photos. Please try again.')
      if (active) { setPhotos(data.photos); setLoaded(true); setError('') }
    }).catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Could not load photos.') })
    return () => { active = false }
  }, [base, reload])
  useEffect(() => {
    if (!busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])
  const merge = (photo: OrderPhoto) => setPhotos((prior) => prior.some((p) => p.id === photo.id)
    ? prior.map((p) => p.id === photo.id ? photo : p) : [...prior, photo])

  async function upload(files: File[]) {
    if (!files.length || lock.current) return
    lock.current = true; setBusy(true); setError(''); setFailed([])
    const failures: File[] = []
    const errors: string[] = []
    let saved = 0
    try {
      for (const [index, source] of files.entries()) {
        setStatus(`Adding photo ${index + 1} of ${files.length}…`)
        try {
          if (source.size > MAX_SOURCE_BYTES) throw new Error('Choose a photo smaller than 30 MB.')
          // Preserve typical photos byte-for-byte; resize only large/HEIC camera files.
          const needsCopy = source.size > MAX_PHOTO_BYTES || /image\/hei[cf]/i.test(source.type) || /\.hei[cf]$/i.test(source.name)
          const file = needsCopy ? await normalizeImage(source, 2560, 0.92) : source
          if (file.size > MAX_PHOTO_BYTES) throw new Error('Choose a smaller copy (under 4 MB).')
          const form = new FormData()
          form.append('photo', file); form.append('resized', String(file !== source))
          const data = await responseData(await fetch(base, { method: 'POST', body: form }))
          if (!data.photo?.id) throw new Error('Could not confirm the photo was saved. Please retry.')
          merge(data.photo); saved++
        } catch (e) {
          failures.push(source)
          errors.push(`${source.name}: ${e instanceof Error ? e.message : 'Could not upload.'}`)
        }
      }
      setFailed(failures); setError(errors.join('\n'))
      setStatus(`${saved} photo${saved === 1 ? '' : 's'} added${failures.length ? `; ${failures.length} could not be added` : ''}.`)
    } finally { lock.current = false; setBusy(false) }
  }

  async function remove(photo: OrderPhoto) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setStatus('')
    try {
      await responseData(await fetch(`${base}/${photo.id}`, { method: 'DELETE' }))
      setPhotos((prior) => prior.filter((p) => p.id !== photo.id))
      setStatus('Photo removed.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not remove the photo.') }
    finally { lock.current = false; setBusy(false) }
  }

  return (
    <section aria-label="Vehicle photos">
      <button type="button" className={`${button} inline-flex items-center gap-2`} disabled={busy || !loaded} onClick={() => input.current?.click()}>
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M8 5l2-2h4l2 2h3a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
          <circle cx="12" cy="12" r="4" />
        </svg>
        Add photos
      </button>
      {/* Let the phone offer its native camera/library chooser in one tap. */}
      <input ref={input} hidden type="file" accept="image/*" multiple disabled={busy || !loaded}
        onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files) }} />
      {!loaded && error && <button type="button" className="ml-3 text-sm text-blue-400" onClick={() => setReload((value) => value + 1)}>Retry</button>}
      {status && <p role="status" className={busy ? 'mt-2 text-sm text-gray-400' : 'sr-only'}>{status}</p>}
      {error && <div role="alert" className="mt-3 rounded-xl border border-red-800 bg-red-950/30 p-3 text-sm text-red-300 whitespace-pre-wrap break-words">
        {error}
        {failed.length > 0 && <button type="button" className={`${button} block mt-3`} disabled={busy} onClick={() => void upload(failed)}>Retry</button>}
      </div>}
      {photos.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
        {photos.map((photo, index) => <div key={photo.id} className="relative h-20 w-20">
          <a href={photo.imageUrl} target="_blank" rel="noreferrer" aria-label={`Open vehicle photo ${index + 1}`} className="block h-full w-full overflow-hidden rounded-lg border border-gray-700">
            {/* Authenticated bytes must not use the public image optimizer. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo.imageUrl} alt={`Vehicle photo ${index + 1}`} className="h-full w-full object-cover" />
          </a>
          <button type="button" aria-label={`Remove vehicle photo ${index + 1}`} title="Remove photo" disabled={busy}
            onClick={() => void remove(photo)} className="absolute -right-1 -top-1 flex h-8 w-8 items-center justify-center rounded-full bg-gray-950/90 text-lg text-white disabled:opacity-40">×</button>
        </div>)}
      </div>}
    </section>
  )
}

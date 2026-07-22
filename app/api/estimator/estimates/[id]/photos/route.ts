import { NextResponse } from 'next/server'
import { uploadPhoto } from '@/platform/blob'
import { createEstimatePhoto, updateEstimate } from '@/apps/estimator/db'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const formData = await req.formData()

    const file  = formData.get('image') as File | null
    const role  = (formData.get('role') as string | null) ?? 'unknown'
    const order = parseInt((formData.get('captureOrder') as string | null) ?? '0', 10)

    if (!file) {
      return NextResponse.json({ error: 'image is required' }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer      = Buffer.from(arrayBuffer)
    const mimeType    = file.type || 'image/jpeg'

    let photoUrl: string
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      // No blob store configured — fall back to inline data URL (dev / demo only)
      photoUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
    } else {
      photoUrl = await uploadPhoto('estimator', file.name, buffer, mimeType)
    }

    const photo = await createEstimatePhoto({
      estimateId:   id,
      photoUrl,
      role,
      captureOrder: order,
    })

    // Advance status to photos_complete on every photo save
    // (the analyze route will set ai_pending when analysis starts)
    await updateEstimate(id, { status: 'photos_complete' })

    return NextResponse.json({ photoId: photo.id, photoUrl: photo.photoUrl })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack   = err instanceof Error ? err.stack : undefined
    console.error('[estimator] POST /estimates/[id]/photos', message, stack)
    return NextResponse.json({ error: 'Internal server error', detail: message }, { status: 500 })
  }
}

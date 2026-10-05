import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { photoOrderExists } from './db'

export const isPhotoId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
export const photoError = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status })

export async function photoAccess(req: Request, orderId: string) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || !isManagerRole(actor.role)) return { response: photoError('Manager access required.', 403) }
  if (!isPhotoId(orderId) || !await photoOrderExists(orderId)) return { response: photoError('Vehicle record not found.', 404) }
  return { actor }
}

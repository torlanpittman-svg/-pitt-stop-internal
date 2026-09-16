/**
 * GET /api/expenses/receipt/[id]/image
 *
 * Authenticated retrieval of a general business-receipt's ORIGINAL image. The image is stored as a
 * PRIVATE Blob (not anonymously accessible); this route is the only way to view it.
 *
 * Security:
 *   - MANAGER/ADMIN only (the review queue is manager-only). Anonymous → 401; employee/non-manager → 403.
 *     Authorization happens BEFORE the DB lookup, so existence is never leaked to an unauthorized caller.
 *   - IDOR-safe: the caller passes an application receipt ID; the Blob pathname is resolved SERVER-SIDE
 *     from that row (decideRetrieval) — a client can never point retrieval at an arbitrary Blob key.
 *   - Content type is clamped to a safe inline image allowlist; anything else is an octet-stream
 *     attachment. `nosniff` + a locked-down CSP prevent inline execution of HTML/SVG/scripts.
 *   - The private Blob is fetched with the server token (never exposed); no URL/token/bytes are logged.
 */
import { NextResponse } from 'next/server'
import { getReceipt } from '@/apps/expenses/db'
import { decideRetrieval } from '@/apps/expenses/view'
import { getPrivateBlob } from '@/platform/blob'
import { authenticatedActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { errorCode } from '@/apps/expenses/errors'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const APP = 'expenses:receipt:image'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // FAIL-CLOSED: authenticatedActorFromRequest never dev-opens (returns null when anonymous). Authorize
  // BEFORE the DB lookup so existence is never leaked; distinguish anonymous (401) from employee (403).
  const actor = await authenticatedActorFromRequest(req).catch(() => null)
  if (!actor || !isManagerRole(actor.role)) {
    const d = decideRetrieval(actor ? { role: actor.role } : null, null)
    return new NextResponse(null, { status: d.ok ? 500 : d.status })
  }

  const row = await getReceipt(id).catch(() => null)
  const decision = decideRetrieval({ role: actor.role }, row)
  if (!decision.ok) return new NextResponse(null, { status: decision.status })

  try {
    const blob = await getPrivateBlob(decision.pathname)
    if (!blob) return new NextResponse(null, { status: 404 })
    return new NextResponse(blob.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': decision.contentType,
        'Content-Disposition': `${decision.disposition}; filename="receipt-${id}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    logger.error(APP, 'retrieve_failed', { code: errorCode(err) }) // never log id/pathname/raw error
    return new NextResponse(null, { status: 500 })
  }
}

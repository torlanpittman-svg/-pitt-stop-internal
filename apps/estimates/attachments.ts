/**
 * QuickBooks estimate attachments — prepare the manager's SELECTED order photos (vehicle photos and
 * parts-quote page images) and attach them to this estimate's native QuickBooks email.
 *
 * Boundaries this module keeps:
 * - Originals in Blob storage are NEVER changed. Email copies are prepared in memory only.
 * - We only ever touch attachments WE created (recognized by a deterministic Note marker bound to this
 *   orderId + photoId + source/prepared hashes). Manual attachments added in QuickBooks are untouched.
 * - Uploads carry a deterministic `requestid`, so a timed-out retry reconciles against the existing
 *   record instead of creating a duplicate. Non-401 writes are never blindly retried here.
 * - Nothing is emailed until every selected file is verifiably attached to THIS estimate with
 *   `IncludeOnSend = true`; a removed/deselected managed file has its `IncludeOnSend` turned off.
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { detectImageMime } from '@/platform/image'
import { readPhotoBytes } from '@/apps/order-photos/storage'
import type { PhotoAttachmentMeta } from '@/apps/order-photos/db'
import { qbApiRequest, qbUploadAttachment, qboEscape } from '@/apps/quickbooks/client'

// Versioned recipe: bump when the email-copy pipeline changes, so prepared-hash identities stay stable.
export const ATTACHMENT_RECIPE_VERSION = 'v1'
const MAX_EDGE = 2000
const JPEG_QUALITY = 82
// Individual prepared cap (QBO per-file) and a conservative aggregate email cap.
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024
const MAX_CAPTION_IN_NOTE = 500
const QUERY_PAGE = 100
const MAX_QUERY_PAGES = 20 // finite bound: up to 2000 attachments on one estimate
const UPLOAD_TIMEOUT_MS = 30_000
const WRITE_TIMEOUT_MS = 20_000
const QUERY_TIMEOUT_MS = 20_000

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex')
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export interface PreparedAttachment {
  photoId: string
  sourceHash: string   // sha256 of the stored bytes (equals order_photos.image_hash); verified
  preparedHash: string // sha256 of the email copy
  filename: string
  contentType: 'image/jpeg' | 'image/png'
  bytes: Buffer
  byteSize: number
  note: string
}

// ── Deterministic marker (recognizes only our uploads; no storage URLs/tokens) ──────────────────────
const MARKER_RE = /^\[PSATT (v\d+) order=(\S+) photo=(\S+) src=([0-9a-f]{64}) prep=([0-9a-f]{64})\]/
export interface AttachmentMarker { version: string; orderId: string; photoId: string; src: string; prep: string }

export function parseAttachmentMarker(note: string | null | undefined): AttachmentMarker | null {
  const m = (note ?? '').match(MARKER_RE)
  return m ? { version: m[1], orderId: m[2], photoId: m[3], src: m[4], prep: m[5] } : null
}

function buildNote(orderId: string, photoId: string, src: string, prep: string, caption: string): string {
  const marker = `[PSATT ${ATTACHMENT_RECIPE_VERSION} order=${orderId} photo=${photoId} src=${src} prep=${prep}]`
  // Caption is advisory only — strip brackets/control chars (keep the marker parseable) and bound it.
  const safe = (caption ?? '').replace(/[[\]\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION_IN_NOTE)
  return safe ? `${marker} ${safe}` : marker
}

// ── Preparation ─────────────────────────────────────────────────────────────────────────────────────
async function toEmailJpeg(bytes: Buffer): Promise<Buffer> {
  // Fixed, deterministic recipe: auto-orient, fit inside MAX_EDGE without enlarging, baseline JPEG q82.
  return sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0', mozjpeg: false })
    .toBuffer()
}

async function toLosslessPng(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function assertDecodable(bytes: Buffer): Promise<void> {
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' })
  const meta = await image.metadata()
  if (!meta.width || !meta.height || (meta.pages ?? 1) > 1) throw new Error('not a single-frame image')
  await image.stats() // Full decode catches a corrupt/truncated PNG; the preserved OUTPUT stays the original bytes.
}

async function prepareOne(orderId: string, meta: PhotoAttachmentMeta): Promise<PreparedAttachment> {
  const bytes = await readPhotoBytes(meta.storagePath)
  if (!bytes) throw new Error(`A selected photo could not be read (${meta.filename}). Remove it or re-upload before sending. Nothing was emailed.`)
  const src = sha256(bytes)
  if (src !== meta.imageHash) throw new Error(`A selected photo failed its integrity check (${meta.filename}). Re-upload it before sending. Nothing was emailed.`)
  const detected = detectImageMime(bytes)
  if (!detected || detected !== meta.contentType) throw new Error(`A selected photo is not a supported image (${meta.filename}). Nothing was emailed.`)

  let out: Buffer
  let contentType: 'image/jpeg' | 'image/png'
  let ext: string
  try {
    if (detected === 'image/png' && bytes.length <= MAX_ATTACHMENT_BYTES) {
      // Parts-quote page images are small, readable PNGs — keep their bytes exact.
      await assertDecodable(bytes)
      out = bytes; contentType = 'image/png'; ext = 'png'
    } else if (detected === 'image/png') {
      out = await toLosslessPng(bytes); contentType = 'image/png'; ext = 'png'
    } else {
      // JPEG / WebP (and any oversized input): one deterministic emailable JPEG copy.
      out = await toEmailJpeg(bytes); contentType = 'image/jpeg'; ext = 'jpg'
    }
  } catch {
    throw new Error(`A selected photo could not be prepared for email (${meta.filename}). Choose a different photo. Nothing was emailed.`)
  }
  if (out.length > MAX_ATTACHMENT_BYTES) throw new Error(`A selected photo is too large to attach (${meta.filename}). Remove it and try again. Nothing was emailed.`)

  const prep = sha256(out)
  const filename = `pittstop-estimate-${meta.id}.${ext}`
  return {
    photoId: meta.id, sourceHash: src, preparedHash: prep, filename, contentType,
    bytes: out, byteSize: out.length, note: buildNote(orderId, meta.id, src, prep, meta.caption),
  }
}

/** Enforce the individual + aggregate email-size caps with an actionable error (no silent omission). */
export function assertAttachmentCaps(prepared: { byteSize: number; filename: string }[]): void {
  for (const p of prepared) {
    if (p.byteSize > MAX_ATTACHMENT_BYTES) throw new Error(`A selected photo is too large to attach (${p.filename}). Remove it and try again. Nothing was emailed.`)
  }
  const total = prepared.reduce((sum, p) => sum + p.byteSize, 0)
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('The selected photos are too large to email together. Remove some photos and send again. Nothing was emailed.')
}

/** Read, verify and prepare every selected photo. Fails closed (before any send) on missing/corrupt/too-large. */
export async function prepareEstimateAttachments(orderId: string, metas: PhotoAttachmentMeta[]): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = []
  for (const meta of metas) prepared.push(await prepareOne(orderId, meta))
  assertAttachmentCaps(prepared)
  return prepared
}

// ── Stable identities for the preview revision and the send request id ───────────────────────────────
/** Source-manifest digest used in the preview revision + concurrent-change recheck (stable ordering). */
export function attachmentManifestFingerprint(metas: PhotoAttachmentMeta[]): string {
  return fingerprint(metas.map(m => ({ id: m.id, hash: m.imageHash, name: m.filename, type: m.contentType, size: m.byteSize, caption: m.caption })))
}

/** Prepared-set digest folded into the send identity, so a changed selection is a distinct send. */
export function attachmentSentIdentity(prepared: PreparedAttachment[]): string {
  return fingerprint({ v: ATTACHMENT_RECIPE_VERSION, items: prepared.map(p => ({ photo: p.photoId, src: p.sourceHash, prep: p.preparedHash, name: p.filename, type: p.contentType, size: p.byteSize })) })
}

// ── QuickBooks reconcile + verify ────────────────────────────────────────────────────────────────────
interface QBAttachableRef { EntityRef?: { type?: string; value?: string }; IncludeOnSend?: boolean }
interface QBAttachable {
  Id?: string; SyncToken?: string; FileName?: string; ContentType?: string; Size?: number; Note?: string
  AttachableRef?: QBAttachableRef[]
}
interface QBAttachableUploadResponse { AttachableResponse?: { Attachable?: QBAttachable; Fault?: unknown }[]; Fault?: unknown }

const AMBIGUOUS = 'A photo attachment in QuickBooks is ambiguous and could not be matched safely. Review it in QuickBooks before sending. Nothing was emailed.'
const MISMATCH = 'A photo attachment in QuickBooks does not match this estimate. Review it in QuickBooks before sending. Nothing was emailed.'

function ours(att: QBAttachable, orderId: string): AttachmentMarker | null {
  const m = parseAttachmentMarker(att.Note)
  return m && m.orderId === orderId ? m : null
}

function estimateRef(att: QBAttachable, qbEstimateId: string): QBAttachableRef | undefined {
  return (att.AttachableRef ?? []).find(r => r.EntityRef?.type === 'Estimate' && r.EntityRef?.value === qbEstimateId)
}

function fullMatch(att: QBAttachable, p: PreparedAttachment, qbEstimateId: string, marker: AttachmentMarker): boolean {
  return marker.photoId === p.photoId && marker.src === p.sourceHash && marker.prep === p.preparedHash
    && att.FileName === p.filename && att.ContentType === p.contentType && Number(att.Size) === p.byteSize
    && Boolean(estimateRef(att, qbEstimateId))
}

/**
 * Run one attachable page through the bounded, authenticated client (NOT the untimed `queryQBO`
 * convenience, which would treat a malformed/faulted body as `{}` → "no matches" → duplicate reuploads).
 * A missing/non-object `QueryResponse` or any `Fault` (even on HTTP 200) is a hard failure; an empty
 * `QueryResponse: {}` correctly means no matches.
 */
async function queryAttachablePage(query: string): Promise<QBAttachable[]> {
  const res = await qbApiRequest<{ QueryResponse?: { Attachable?: QBAttachable[] }; Fault?: unknown }>({
    path: '/query', query: { query }, timeoutMs: QUERY_TIMEOUT_MS,
  })
  if (res.Fault || !res.QueryResponse || typeof res.QueryResponse !== 'object' || Array.isArray(res.QueryResponse)) {
    throw new Error('QuickBooks could not list this estimate’s attachments. Nothing was emailed. Try again.')
  }
  return res.QueryResponse.Attachable ?? []
}

async function queryEstimateAttachables(qbEstimateId: string): Promise<QBAttachable[]> {
  const esc = qboEscape(qbEstimateId)
  const all: QBAttachable[] = []
  for (let page = 0; page < MAX_QUERY_PAGES; page++) {
    const start = 1 + page * QUERY_PAGE
    const query = `select * from attachable where AttachableRef.EntityRef.Type = 'Estimate' and AttachableRef.EntityRef.Value = '${esc}' startposition ${start} maxresults ${QUERY_PAGE}`
    const rows = await queryAttachablePage(query)
    all.push(...rows)
    if (rows.length < QUERY_PAGE) return all
  }
  throw new Error('This estimate has too many attachments to reconcile safely. Review it in QuickBooks before sending. Nothing was emailed.')
}

async function setIncludeOnSend(att: QBAttachable, qbEstimateId: string, include: boolean): Promise<void> {
  // Validate the record + the specific version + the current estimate ref before mutating it.
  if (!att.Id || att.SyncToken == null || !estimateRef(att, qbEstimateId)) throw new Error(MISMATCH)
  const refs = (att.AttachableRef ?? []).map(r =>
    r.EntityRef?.type === 'Estimate' && r.EntityRef?.value === qbEstimateId ? { ...r, IncludeOnSend: include } : r)
  // Request id binds Id + SyncToken + estimate + desired flag: a retry of the SAME version is a safe
  // replay, but once the version advances (SyncToken changes) a fresh toggle gets a NEW id — so
  // off→on→off never replays a stale earlier result and strands the photo.
  const requestid = `t-${fingerprint({ id: att.Id, sync: att.SyncToken, est: qbEstimateId, include }).slice(0, 38)}`
  await qbApiRequest({ method: 'POST', path: '/attachable', body: { ...att, AttachableRef: refs, SyncToken: att.SyncToken }, query: { requestid }, timeoutMs: WRITE_TIMEOUT_MS })
}

async function uploadOne(orderId: string, qbEstimateId: string, p: PreparedAttachment): Promise<void> {
  const metadata = {
    AttachableRef: [{ EntityRef: { type: 'Estimate', value: qbEstimateId }, IncludeOnSend: true }],
    FileName: p.filename, ContentType: p.contentType, Note: p.note,
  }
  // Deterministic per prepared file on THIS estimate: a timed-out retry reconciles to this record, never a duplicate.
  const requestid = `a-${fingerprint({ orderId, est: qbEstimateId, photo: p.photoId, prep: p.preparedHash }).slice(0, 38)}`
  const res = await qbUploadAttachment<QBAttachableUploadResponse>({
    metadata, content: p.bytes, contentType: p.contentType, filename: p.filename, query: { requestid }, timeoutMs: UPLOAD_TIMEOUT_MS,
  })
  const entry = res.AttachableResponse?.[0]
  if (res.Fault || !entry || entry.Fault || !entry.Attachable?.Id) {
    throw new Error(`QuickBooks did not accept a photo attachment (${p.filename}). Nothing was emailed.`)
  }
}

/**
 * Bring the estimate's attachments to exactly the prepared set: upload what is missing, repair a
 * managed file whose IncludeOnSend was cleared, and disable (never delete) any previously managed file
 * that is no longer selected. Blocks rather than guesses when it cannot confidently dedup. Verifies the
 * final state with a fresh query before returning so the caller can send.
 */
export async function reconcileEstimateAttachments(args: { orderId: string; qbEstimateId: string; prepared: PreparedAttachment[] }): Promise<void> {
  const { orderId, qbEstimateId, prepared } = args
  const existing = await queryEstimateAttachables(qbEstimateId)

  const oursByPhoto = new Map<string, { att: QBAttachable; marker: AttachmentMarker }>()
  const ambiguous = new Set<string>()
  for (const att of existing) {
    const m = ours(att, orderId)
    if (!m) continue
    if (oursByPhoto.has(m.photoId)) ambiguous.add(m.photoId)
    oursByPhoto.set(m.photoId, { att, marker: m })
  }
  if (ambiguous.size) throw new Error(AMBIGUOUS)

  const wanted = new Set(prepared.map(p => p.photoId))
  // Disable managed files that are no longer selected (keep the record + any other entity refs).
  for (const [photoId, { att }] of oursByPhoto) {
    if (wanted.has(photoId)) continue
    const ref = estimateRef(att, qbEstimateId)
    if (ref?.IncludeOnSend) await setIncludeOnSend(att, qbEstimateId, false)
  }
  // Ensure every selected file is present and marked to send.
  for (const p of prepared) {
    const found = oursByPhoto.get(p.photoId)
    if (!found) { await uploadOne(orderId, qbEstimateId, p); continue }
    if (!fullMatch(found.att, p, qbEstimateId, found.marker)) throw new Error(MISMATCH)
    const ref = estimateRef(found.att, qbEstimateId)!
    if (!ref.IncludeOnSend) await setIncludeOnSend(found.att, qbEstimateId, true)
  }

  await verifyEstimateAttachments(args)
}

/** Independent read-back: every selected file is attached to THIS estimate with IncludeOnSend true, and no removed managed file still sends. */
export async function verifyEstimateAttachments(args: { orderId: string; qbEstimateId: string; prepared: PreparedAttachment[] }): Promise<void> {
  const { orderId, qbEstimateId, prepared } = args
  const existing = await queryEstimateAttachables(qbEstimateId)
  for (const p of prepared) {
    const matches = existing.filter(att => ours(att, orderId)?.photoId === p.photoId)
    if (matches.length !== 1) throw new Error(matches.length ? AMBIGUOUS : `A photo attachment could not be verified in QuickBooks (${p.filename}). Nothing was emailed.`)
    const att = matches[0]
    if (!fullMatch(att, p, qbEstimateId, ours(att, orderId)!)) throw new Error(MISMATCH)
    if (!estimateRef(att, qbEstimateId)!.IncludeOnSend) throw new Error(`A photo attachment is not marked to send in QuickBooks (${p.filename}). Nothing was emailed.`)
  }
  for (const att of existing) {
    const m = ours(att, orderId)
    if (!m || prepared.some(p => p.photoId === m.photoId)) continue
    if (estimateRef(att, qbEstimateId)?.IncludeOnSend) throw new Error('A removed photo is still attached to this estimate in QuickBooks. Review it before sending. Nothing was emailed.')
  }
}

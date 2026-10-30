import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

/**
 * Printer-routing safety for the claim endpoint:
 *   - a bridge that does NOT declare a label printer is never handed a sticker job
 *     (an old bridge would otherwise print a label on the check printer);
 *   - a bridge that does gets check kinds + 'sticker';
 *   - sticker jobs render through the stickers module, checks through the checks module;
 *   - real token auth (fail closed) still guards everything.
 */
const h = vi.hoisted(() => ({
  claim: vi.fn(), heartbeat: vi.fn(), reconcile: vi.fn(), renderCheck: vi.fn(), renderSticker: vi.fn(),
}))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/apps/checks/print-queue', async (orig) => ({
  ...(await orig<typeof import('@/apps/checks/print-queue')>()),
  claimNextJob: h.claim, recordBridgeHeartbeat: h.heartbeat,
}))
vi.mock('@/apps/checks/service', () => ({ reconcileExpiredJobs: h.reconcile, renderClaimedJob: h.renderCheck }))
vi.mock('@/apps/stickers/service', () => ({ renderStickerJob: h.renderSticker }))

import { POST } from './route'

const TOKEN = 'test-bridge-token-16chars-long'
const request = (body: Record<string, unknown>, token: string | null = TOKEN) =>
  new Request('https://os.example.test/api/print-bridge/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const stickerJob = { id: 'J1', kind: 'sticker', printerTarget: 'label', checkId: null, status: 'claimed', payload: {} }
const checkJob = { id: 'J2', kind: 'check', printerTarget: null, checkId: 'C1', status: 'claimed', payload: {} }

beforeEach(() => {
  vi.stubEnv('PRINT_BRIDGE_TOKEN', TOKEN)
  Object.values(h).forEach((m) => m.mockReset())
  h.reconcile.mockResolvedValue(0)
  h.heartbeat.mockResolvedValue(undefined)
  h.claim.mockResolvedValue(null)
  h.renderCheck.mockResolvedValue({ pdf: Buffer.from('%PDF-check') })
  h.renderSticker.mockResolvedValue({ pdf: Buffer.from('%PDF-sticker') })
})
afterEach(() => vi.unstubAllEnvs())

describe('claim — kind gating by declared label printer', () => {
  it('a bridge WITHOUT a label printer is only offered check-family kinds', async () => {
    await POST(request({ bridgeId: 'OLD-LAPTOP', version: '2.0.1' }))
    expect(h.claim).toHaveBeenCalledWith('OLD-LAPTOP', ['check', 'reprint', 'specimen'])
  })
  it('a bridge WITH a label printer is also offered sticker jobs', async () => {
    await POST(request({ bridgeId: 'SHOP', labelPrinter: 'Brother QL-800' }))
    expect(h.claim).toHaveBeenCalledWith('SHOP', ['check', 'reprint', 'specimen', 'sticker'])
  })
  it('records the label printer in the heartbeat', async () => {
    await POST(request({ bridgeId: 'SHOP', labelPrinter: 'Brother QL-800' }))
    expect(h.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ labelPrinter: 'Brother QL-800' }))
  })
})

describe('claim — render dispatch', () => {
  it('a sticker job renders through the stickers module and carries its printer target', async () => {
    h.claim.mockResolvedValue(stickerJob)
    const res = await POST(request({ bridgeId: 'SHOP', labelPrinter: 'Brother QL-800' }))
    const json = await res.json()
    expect(h.renderSticker).toHaveBeenCalledWith(stickerJob)
    expect(h.renderCheck).not.toHaveBeenCalled()
    expect(json.job).toEqual({ id: 'J1', kind: 'sticker', printerTarget: 'label' })
    expect(Buffer.from(json.pdfBase64, 'base64').toString()).toBe('%PDF-sticker')
  })
  it('a check job renders through the checks module, untouched by sticker code', async () => {
    h.claim.mockResolvedValue(checkJob)
    const res = await POST(request({ bridgeId: 'SHOP', labelPrinter: 'Brother QL-800' }))
    const json = await res.json()
    expect(h.renderCheck).toHaveBeenCalledWith(checkJob)
    expect(h.renderSticker).not.toHaveBeenCalled()
    expect(json.job.kind).toBe('check')
  })
  it('a refused render returns job:null with the reason — nothing to print', async () => {
    h.claim.mockResolvedValue(stickerJob)
    h.renderSticker.mockResolvedValue({ refused: 'sticker payload is malformed — not printed' })
    const json = await (await POST(request({ bridgeId: 'SHOP', labelPrinter: 'Brother QL-800' }))).json()
    expect(json.job).toBeNull()
    expect(json.refused.id).toBe('J1')
  })
})

describe('claim — auth stays fail-closed', () => {
  it('rejects a wrong token', async () => {
    expect((await POST(request({}, 'wrong-token-wrong-token'))).status).toBe(401)
  })
  it('rejects when no token is configured', async () => {
    vi.stubEnv('PRINT_BRIDGE_TOKEN', '')
    expect((await POST(request({}))).status).toBe(503)
  })
})

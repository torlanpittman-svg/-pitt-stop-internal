import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// redirect throws (like Next) so we can assert the gate fired before any provider work.
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`) }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/apps/checks/authz', () => ({ managerActor: vi.fn() }))
vi.mock('@/apps/marketing/manual-send', () => ({
  confirmSendEmail: vi.fn(),
  confirmPublishFacebook: vi.fn(),
  manualErrorMessage: (c: string) => c,
}))

import { sendCampaignEmailAction, publishPostFacebookAction } from '@/app/marketing/actions'
import { managerActor } from '@/apps/checks/authz'
import { confirmSendEmail, confirmPublishFacebook } from '@/apps/marketing/manual-send'

const ID = '11111111-1111-4111-8111-111111111111'
const HEX = 'a'.repeat(64)
function form(fields: Record<string, string>): FormData { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd }

beforeEach(() => vi.clearAllMocks())

describe('manual send actions — manager auth before any provider work', () => {
  it('rejects a non-manager and never calls the send path', async () => {
    ;(managerActor as Mock).mockResolvedValue(null)
    await expect(sendCampaignEmailAction(form({ id: ID, confirm: 'send-email', contentHash: HEX, audienceHash: HEX }))).rejects.toThrow(/REDIRECT:\/auto-sales\/login/)
    expect(confirmSendEmail).not.toHaveBeenCalled()
  })

  it('a manager with explicit confirmation + preview fingerprints performs the send', async () => {
    ;(managerActor as Mock).mockResolvedValue({ name: 'Manager Mia', role: 'manager' })
    ;(confirmSendEmail as Mock).mockResolvedValue({ status: 'accepted', externalRef: '555', audienceCount: 1 })
    await expect(sendCampaignEmailAction(form({ id: ID, confirm: 'send-email', contentHash: HEX, audienceHash: HEX }))).rejects.toThrow(/REDIRECT:\/marketing\/campaigns\/.*\?msg=/)
    expect(confirmSendEmail).toHaveBeenCalledWith(ID, 'Manager Mia', { expected: { contentHash: HEX, audienceHash: HEX } })
  })

  it('refuses to send without the explicit confirm token', async () => {
    ;(managerActor as Mock).mockResolvedValue({ name: 'Mia', role: 'manager' })
    await expect(sendCampaignEmailAction(form({ id: ID, contentHash: HEX, audienceHash: HEX }))).rejects.toThrow(/REDIRECT:.*err=/)
    expect(confirmSendEmail).not.toHaveBeenCalled()
  })

  it('cannot send with a missing or malformed content/audience fingerprint', async () => {
    ;(managerActor as Mock).mockResolvedValue({ name: 'Mia', role: 'manager' })
    // missing both
    await expect(sendCampaignEmailAction(form({ id: ID, confirm: 'send-email' }))).rejects.toThrow(/REDIRECT:.*err=/)
    // missing audience hash
    await expect(sendCampaignEmailAction(form({ id: ID, confirm: 'send-email', contentHash: HEX }))).rejects.toThrow(/REDIRECT:.*err=/)
    // malformed content hash (not 64 hex)
    await expect(sendCampaignEmailAction(form({ id: ID, confirm: 'send-email', contentHash: 'nope', audienceHash: HEX }))).rejects.toThrow(/REDIRECT:.*err=/)
    expect(confirmSendEmail).not.toHaveBeenCalled()
  })

  it('facebook publish gates on manager auth and on the content fingerprint', async () => {
    ;(managerActor as Mock).mockResolvedValue(null)
    await expect(publishPostFacebookAction(form({ id: ID, confirm: 'publish-facebook', contentHash: HEX }))).rejects.toThrow(/REDIRECT:\/auto-sales\/login/)
    expect(confirmPublishFacebook).not.toHaveBeenCalled()
    // manager, but missing fingerprint → refused before any publish
    ;(managerActor as Mock).mockResolvedValue({ name: 'Mia', role: 'manager' })
    await expect(publishPostFacebookAction(form({ id: ID, confirm: 'publish-facebook' }))).rejects.toThrow(/REDIRECT:.*err=/)
    expect(confirmPublishFacebook).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// redirect throws a tagged error (as Next's does) so we can assert the auth gate fired before any write.
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`) }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/apps/checks/authz', () => ({ managerActor: vi.fn() }))
vi.mock('@/apps/marketing/leads', () => ({ createLead: vi.fn(async () => ({ id: 'lead-1' })), updateLead: vi.fn() }))

import { createLeadAction } from '@/app/marketing/actions'
import { managerActor } from '@/apps/checks/authz'
import { createLead } from '@/apps/marketing/leads'

function leadForm(): FormData {
  const fd = new FormData()
  fd.set('name', 'Bob')
  fd.set('source', 'referral')
  return fd
}

beforeEach(() => vi.clearAllMocks())

describe('marketing action auth — manager gate before any mutation', () => {
  it('rejects a non-manager (employee/none) and never mutates', async () => {
    ;(managerActor as Mock).mockResolvedValue(null) // employee / unauthenticated
    await expect(createLeadAction(leadForm())).rejects.toThrow(/REDIRECT:\/auto-sales\/login/)
    expect(createLead).not.toHaveBeenCalled()
  })

  it('allows a manager and performs the mutation', async () => {
    ;(managerActor as Mock).mockResolvedValue({ name: 'Manager Mia', role: 'manager' })
    await createLeadAction(leadForm())
    expect(createLead).toHaveBeenCalledTimes(1)
    expect((createLead as Mock).mock.calls[0][1]).toBe('Manager Mia') // actor passed through
  })
})

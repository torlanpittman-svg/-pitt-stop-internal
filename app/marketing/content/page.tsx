import { requireMarketingManager, MarketingShell, Section, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { shortDate } from '@/app/lib/format'
import { listPosts, findContentCandidates } from '@/apps/marketing/content'
import { listConversations } from '@/apps/marketing/comments'
import { WEEKLY_FACEBOOK_PLAN } from '@/apps/marketing/calendar'
import {
  createPostAction, generatePostAction, postFromCandidateAction, updatePostAction,
  ingestCommentAction, resolveConversationAction,
} from '@/app/marketing/actions'
import {
  CONTENT_PILLARS, SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS,
  type ServiceCategory,
} from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INPUT = 'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm'
const PRIMARY = 'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500'
const POST_STATUS_OPTIONS = ['draft', 'approved', 'scheduled', 'posted', 'archived'] as const

const svcLabel = (s: string | null | undefined): string =>
  s ? (SERVICE_CATEGORY_LABELS[s as ServiceCategory] ?? s) : '—'
const toYmd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null)

export default async function MarketingContent() {
  await requireMarketingManager('/marketing/content')
  const [posts, candidates, conversations] = await Promise.all([
    listPosts({ limit: 100 }),
    findContentCandidates(25),
    listConversations(),
  ])

  return (
    <MarketingShell active="/marketing/content" title="Content">
      <p className="mb-4 text-sm text-gray-500">
        Three Facebook posts a week — educate, proof, sell. Nothing auto-publishes; a manager approves every post.
      </p>

      <Section title="This week's Facebook plan">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {WEEKLY_FACEBOOK_PLAN.map((p) => (
            <div key={p.day} className="rounded-xl border border-gray-800 bg-gray-950 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{p.day}</span>
                <StatusChip status={p.pillar} />
              </div>
              <p className="mt-2 text-xs text-gray-400">{p.note}</p>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Draft a post (AI / template)">
          <form action={generatePostAction} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs">
                <span className="mb-1 block uppercase tracking-wide text-gray-500">Pillar</span>
                <select name="pillar" className={INPUT} defaultValue="educate">
                  {CONTENT_PILLARS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block uppercase tracking-wide text-gray-500">Target service</span>
                <select name="targetService" className={INPUT} defaultValue="ceramic">
                  {SERVICE_CATEGORIES.map((s) => <option key={s} value={s}>{SERVICE_CATEGORY_LABELS[s]}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-wide text-gray-500">Vehicle (optional)</span>
              <input type="text" name="vehicle" className={INPUT} placeholder="2021 Tahoe" />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-wide text-gray-500">Service performed (optional)</span>
              <input type="text" name="servicePerformed" className={INPUT} placeholder="Ceramic coating + decon" />
            </label>
            <button type="submit" className={PRIMARY}>Generate draft (AI/template)</button>
          </form>
        </Section>

        <Section title="Add a manual post">
          <form action={createPostAction} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs">
                <span className="mb-1 block uppercase tracking-wide text-gray-500">Pillar</span>
                <select name="pillar" className={INPUT} defaultValue="educate">
                  {CONTENT_PILLARS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block uppercase tracking-wide text-gray-500">Target service</span>
                <select name="targetService" className={INPUT} defaultValue="ceramic">
                  {SERVICE_CATEGORIES.map((s) => <option key={s} value={s}>{SERVICE_CATEGORY_LABELS[s]}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-wide text-gray-500">Copy</span>
              <textarea name="copy" rows={4} className={INPUT} placeholder="Write the post copy…" />
            </label>
            <button type="submit" className={PRIMARY}>Add manual post</button>
          </form>
        </Section>
      </div>

      <Section title="Content candidates from completed jobs">
        {candidates.length === 0 ? (
          <EmptyRow>No completed jobs with before/after photos yet.</EmptyRow>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500">
                <th className="pb-2">Vehicle</th>
                <th className="pb-2">Service</th>
                <th className="pb-2 text-right">Photos</th>
                <th className="pb-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.serviceOrderId} className="border-t border-gray-800">
                  <td className="py-2">{c.vehicleLabel || '—'}</td>
                  <td className="py-2">{SERVICE_CATEGORY_LABELS[c.category]}</td>
                  <td className="py-2 text-right">{c.photoCount}</td>
                  <td className="py-2 text-right">
                    <form action={postFromCandidateAction} className="inline">
                      <input type="hidden" name="orderId" value={c.serviceOrderId} />
                      <button type="submit" className={PRIMARY}>Create proof post</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Post queue">
        {posts.length === 0 ? (
          <EmptyRow>No posts yet. Draft this week&apos;s educate / proof / sell posts.</EmptyRow>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500">
                <th className="pb-2">Pillar</th>
                <th className="pb-2">Target service</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Created</th>
                <th className="pb-2">Copy</th>
                <th className="pb-2 text-right">Update</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id} className="border-t border-gray-800 align-top">
                  <td className="py-2 uppercase text-gray-400">{p.pillar}</td>
                  <td className="py-2">{svcLabel(p.targetService)}</td>
                  <td className="py-2"><StatusChip status={p.status} /></td>
                  <td className="py-2 whitespace-nowrap text-gray-400">{shortDate(toYmd(p.createdAt))}</td>
                  <td className="py-2 max-w-xs"><span className="line-clamp-2 text-gray-400">{p.copy || '—'}</span></td>
                  <td className="py-2 text-right">
                    <form action={updatePostAction} className="flex items-center justify-end gap-2">
                      <input type="hidden" name="id" value={p.id} />
                      <select name="status" className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs" defaultValue={p.status}>
                        {POST_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <button type="submit" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Save</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Comment assistant queue">
        <form action={ingestCommentAction} className="mb-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block text-xs sm:col-span-1">
              <span className="mb-1 block uppercase tracking-wide text-gray-500">Author name</span>
              <input type="text" name="authorName" className={INPUT} placeholder="Jane from Facebook" />
            </label>
            <label className="block text-xs sm:col-span-2">
              <span className="mb-1 block uppercase tracking-wide text-gray-500">Message</span>
              <textarea name="message" rows={2} className={INPUT} placeholder="Paste the inbound comment or message…" />
            </label>
          </div>
          <button type="submit" className={PRIMARY}>Classify &amp; queue</button>
        </form>

        {conversations.length === 0 ? (
          <EmptyRow>No conversations queued yet.</EmptyRow>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500">
                <th className="pb-2">Author</th>
                <th className="pb-2">Message</th>
                <th className="pb-2">Topic</th>
                <th className="pb-2">State</th>
                <th className="pb-2">Suggested reply</th>
                <th className="pb-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id} className="border-t border-gray-800 align-top">
                  <td className="py-2 whitespace-nowrap">{c.authorName || '—'}</td>
                  <td className="py-2 max-w-xs"><span className="line-clamp-2 text-gray-400">{c.message}</span></td>
                  <td className="py-2 text-gray-400">{c.topic || '—'}</td>
                  <td className="py-2"><StatusChip status={c.state} /></td>
                  <td className="py-2 max-w-xs">
                    <span className="line-clamp-2 text-gray-400">
                      {c.escalationReason ? '— escalated —' : (c.suggestedReply || '—')}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    {c.state !== 'answered' && (
                      <form action={resolveConversationAction} className="inline">
                        <input type="hidden" name="id" value={c.id} />
                        <button type="submit" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Mark answered</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </MarketingShell>
  )
}

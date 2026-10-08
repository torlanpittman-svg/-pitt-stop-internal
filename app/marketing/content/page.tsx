import { requireMarketingManager, MarketingShell, Section, StatusChip, EmptyRow, Pager, FlashBanner } from '@/app/marketing/_components'
import { shortDate } from '@/app/lib/format'
import { listPosts, findContentCandidates, countPosts } from '@/apps/marketing/content'
import { listConversations } from '@/apps/marketing/comments'
import { WEEKLY_FACEBOOK_PLAN } from '@/apps/marketing/calendar'
import {
  createPostAction, generatePostAction, postFromCandidateAction, updatePostAction,
  ingestCommentAction, resolveConversationAction, seedWeeklyPlanAction, publishPostFacebookAction,
} from '@/app/marketing/actions'
import { manualFacebookBlockers, facebookConnection, contentFingerprint } from '@/apps/marketing/manual-send'
import {
  CONTENT_PILLARS, SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS,
  type ServiceCategory,
} from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INPUT = 'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm'
const PRIMARY = 'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500'
const POST_STATUS_OPTIONS = ['draft', 'approved', 'scheduled', 'posted', 'archived'] as const
const CONVERSATION_STATES = ['answered', 'archived'] as const
const PAGE_SIZE = 25

const svcLabel = (s: string | null | undefined): string =>
  s ? (SERVICE_CATEGORY_LABELS[s as ServiceCategory] ?? s) : '—'
const toYmd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null)

export default async function MarketingContent({ searchParams }: { searchParams: Promise<{ page?: string; err?: string; msg?: string; fb?: string }> }) {
  await requireMarketingManager('/marketing/content')
  const { page: pageRaw, err, msg, fb } = await searchParams
  const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1)
  const [posts, postTotal, candidates, conversations] = await Promise.all([
    listPosts({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countPosts(),
    findContentCandidates(25),
    listConversations(),
  ])
  const fbBlockers = manualFacebookBlockers()
  const publishable = posts.filter((p) => ['approved', 'scheduled'].includes(p.status) && !p.externalPostRef && !p.beforePhotoId && !p.afterPhotoId)
  // Confirm the Page identity read-only (verify) only when the manager asks — never inferred from env.
  const fbConn = fb === '1' && fbBlockers.length === 0 ? await facebookConnection() : null

  return (
    <MarketingShell active="/marketing/content" title="Content">
      <FlashBanner err={err} msg={msg} />
      <p className="mb-4 text-sm text-gray-500">
        Three Facebook posts a week — educate, proof, sell. Nothing auto-publishes; a manager approves every post.
      </p>

      <Section
        title="This week's Facebook plan"
        right={
          <form action={seedWeeklyPlanAction}>
            <button type="submit" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">
              Add this week&apos;s 3 posts
            </button>
          </form>
        }
      >
        <p className="mb-3 text-xs text-gray-500">
          &ldquo;Add this week&apos;s 3 posts&rdquo; seeds Mon/Wed/Fri drafts on their cadence days. It&apos;s idempotent —
          pressing it again (or next visit) never creates duplicate drafts for a day already seeded.
        </p>
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
        <p className="mb-3 text-xs text-gray-500">
          Completed jobs with a known premium service and 2+ photos. &ldquo;Create proof post&rdquo; drafts the copy only —
          it does <span className="text-gray-300">not</span> guess which photo is before vs after (photos carry no such role).
          A manager must pick and verify the before/after shots before anything is published.
        </p>
        {candidates.length === 0 ? (
          <EmptyRow>No completed jobs with 2+ photos and a known premium service yet.</EmptyRow>
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
                  <td className="py-2 whitespace-nowrap text-gray-400">
                    {shortDate(toYmd(p.createdAt))}
                    {p.scheduledAt && <div className="text-[11px] text-blue-400">→ {shortDate(toYmd(p.scheduledAt))}</div>}
                    {p.externalPostRef && <div className="max-w-[12rem] truncate text-[11px] text-emerald-400" title={p.externalPostRef}>published: {p.externalPostRef}</div>}
                  </td>
                  <td className="py-2" colSpan={2}>
                    <form action={updatePostAction} className="space-y-2">
                      <input type="hidden" name="id" value={p.id} />
                      <textarea name="copy" rows={2} defaultValue={p.copy} className={INPUT} placeholder="Edit the post copy…" />
                      <div className="flex flex-wrap items-center gap-2">
                        <select name="status" className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs" defaultValue={p.status}>
                          {POST_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <label className="text-[11px] text-gray-500">Schedule
                          <input type="date" name="scheduledAt" defaultValue={toYmd(p.scheduledAt) ?? ''} className="ml-1 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs" />
                        </label>
                        <input name="externalPostRef" defaultValue={p.externalPostRef ?? ''} placeholder="published FB post link (when Posted)" className="w-56 rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs" />
                        <button type="submit" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Save</button>
                      </div>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager basePath="/marketing/content" page={page} pageSize={PAGE_SIZE} total={postTotal} />
      </Section>

      <Section title="Publish to Facebook (manual, live)">
        <p className="mb-3 text-xs text-gray-500">
          Publishes the exact approved copy to the Pitt Stop Page with a tracked link — a real, manager-confirmed action,
          not a dry-run. Photo posts aren&apos;t published here: post the image on Facebook directly, then record the link in the queue.
        </p>
        {fbBlockers.length > 0 ? (
          <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-amber-200">{fbBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
        ) : !fbConn ? (
          <a href="/marketing/content?fb=1" className="mb-3 inline-block rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">Check Facebook connection…</a>
        ) : fbConn.connected ? (
          <p className="mb-3 text-sm text-emerald-300">Connected to Page <span className="font-semibold">{fbConn.pageName}</span> (ID {fbConn.pageId}).</p>
        ) : (
          <p className="mb-3 text-sm text-amber-300">Facebook Page not verified{fbConn.error ? ` (${fbConn.error})` : ''}. Resolve this before publishing; env credentials alone do not confirm a connection.</p>
        )}
        {publishable.length === 0 ? (
          <EmptyRow>No approved text posts awaiting publish. Approve a post in the queue above first.</EmptyRow>
        ) : (
          <div className="space-y-3">
            {publishable.map((p) => (
              <article key={p.id} className="rounded-xl border border-gray-800 bg-gray-950 p-3">
                <div className="flex items-center gap-2 text-xs"><StatusChip status={p.status} /><span className="uppercase text-gray-500">{p.pillar}{p.targetService ? ` · ${svcLabel(p.targetService)}` : ''}</span></div>
                <p className="mt-2 whitespace-pre-line text-sm text-gray-300">{p.copy}</p>
                {fbConn?.connected && (
                  <form action={publishPostFacebookAction} className="mt-2">
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="confirm" value="publish-facebook" />
                    <input type="hidden" name="contentHash" value={contentFingerprint('', (p.copy ?? '').trim())} />
                    <button type="submit" className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600">Publish to Facebook now</button>
                  </form>
                )}
              </article>
            ))}
          </div>
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
                    {c.escalationReason
                      ? <span className="text-amber-400">— escalated: {c.escalationReason} — handle personally</span>
                      : <span className="line-clamp-3 text-gray-400">{c.suggestedReply || '—'}</span>}
                  </td>
                  <td className="py-2">
                    {c.state === 'answered' || c.state === 'archived' ? (
                      <span className="text-xs text-gray-500">{c.handledBy ? `by ${c.handledBy}` : 'done'}</span>
                    ) : (
                      <form action={resolveConversationAction} className="space-y-2">
                        <input type="hidden" name="id" value={c.id} />
                        {!c.escalationReason && (
                          <textarea name="suggestedReply" rows={2} defaultValue={c.suggestedReply ?? ''} className={INPUT} placeholder="Edit the reply you'll post…" />
                        )}
                        <div className="flex items-center gap-2">
                          <select name="state" defaultValue="answered" className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs">
                            {CONVERSATION_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <button type="submit" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Save</button>
                        </div>
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

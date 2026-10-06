/**
 * Public unsubscribe landing. Reached via the token link in a marketing message — NO auth (it is a
 * customer-facing opt-out), and intentionally NOT in the proxy matcher. GET never mutates (a prefetch
 * must not opt someone out); the opt-out happens only on the explicit POST (confirm button), which is
 * idempotent.
 */
import { redirect } from 'next/navigation'
import { unsubscribeByToken } from '@/apps/marketing/consent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function confirmUnsubscribe(formData: FormData): Promise<void> {
  'use server'
  const token = String(formData.get('token') ?? '')
  const reason = String(formData.get('reason') ?? '') || 'customer_request'
  if (token) await unsubscribeByToken(token, { reason, scope: 'all' })
  redirect(`/unsubscribe/${encodeURIComponent(token)}?done=1`)
}

export default async function UnsubscribePage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ done?: string }>
}) {
  const { token } = await params
  const { done } = await searchParams

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-950 px-4 text-white">
      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6">
        <h1 className="text-lg font-bold">Pitt Stop — Marketing preferences</h1>
        {done ? (
          <p className="mt-3 text-sm text-emerald-400">
            You’ve been unsubscribed from marketing messages. You may still receive messages about an active job.
            Changed your mind? Just reply to any message and we’ll turn them back on.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm text-gray-400">
              Click below to stop receiving marketing texts and emails from Pitt Stop. This won’t affect messages
              about a vehicle currently in the shop.
            </p>
            <form action={confirmUnsubscribe} className="mt-4 space-y-3">
              <input type="hidden" name="token" value={token} />
              <input name="reason" placeholder="Optional: reason (not required)"
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
              <button className="w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">
                Unsubscribe from marketing
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}

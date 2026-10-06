/**
 * Shared marketing UI: the manager gate, the section sub-nav, and a few dense presentational
 * helpers. Matches the Pitt Stop dark operational aesthetic — tables and status chips, no fluff.
 * (Folder name is route-irrelevant; files here are imported, not routed.)
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { marketingEnabled } from '@/apps/settings/db'
import NavHeader from '@/app/components/NavHeader'
import { Badge } from '@/app/components/ui'
import type { AuthedActor } from '@/apps/auth/employee-session'

/** Gate every marketing page: feature flag on + manager/admin, else redirect. */
export async function requireMarketingManager(path = '/marketing'): Promise<AuthedActor> {
  const enabled = await marketingEnabled()
  if (!enabled) redirect('/')
  const actor = await managerActor()
  if (!actor) redirect(`/auto-sales/login?next=${encodeURIComponent(path)}`)
  return actor
}

const TABS: Array<{ href: string; label: string }> = [
  { href: '/marketing', label: 'Overview' },
  { href: '/marketing/campaigns', label: 'Campaigns' },
  { href: '/marketing/segments', label: 'Segments' },
  { href: '/marketing/content', label: 'Content' },
  { href: '/marketing/calendar', label: 'Calendar' },
  { href: '/marketing/leads', label: 'Leads' },
  { href: '/marketing/google-ads', label: 'Google Ads' },
  { href: '/marketing/attribution', label: 'Attribution' },
  { href: '/marketing/report', label: 'Weekly Report' },
  { href: '/marketing/sms', label: 'SMS Launch' },
  { href: '/marketing/settings', label: 'Settings' },
]

export function MarketingShell({ active, title, actions, children }: { active: string; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/', label: 'Home' }} title="Marketing" />
      <nav className="sticky top-[49px] z-20 flex gap-1 overflow-x-auto border-b border-gray-900 bg-gray-950/95 px-3 py-2 backdrop-blur">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${t.href === active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-white'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mx-auto max-w-6xl px-3 py-5 sm:px-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          {actions}
        </div>
        {children}
      </div>
    </main>
  )
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5 rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white">{value}</div>
      {note && <div className="mt-0.5 text-xs text-gray-500">{note}</div>}
    </div>
  )
}

const STATUS_TONES: Record<string, 'neutral' | 'brand' | 'positive' | 'warn' | 'danger' | 'info'> = {
  draft: 'neutral', ready: 'info', scheduled: 'info', sending: 'warn', sent: 'positive',
  paused: 'warn', completed: 'positive', cancelled: 'danger',
  new: 'info', contacted: 'info', estimate_needed: 'warn', estimate_sent: 'warn', booked: 'brand',
  won: 'positive', lost: 'danger', no_response: 'neutral',
  idea: 'neutral', approved: 'info', posted: 'positive', archived: 'neutral', failed: 'danger',
  escalated: 'danger', needs_review: 'warn', suggested: 'info', answered: 'positive',
}

export function StatusChip({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-gray-800 bg-gray-950 px-4 py-8 text-center text-sm text-gray-500">{children}</div>
}

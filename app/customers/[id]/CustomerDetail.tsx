'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import NavHeader from '@/app/components/NavHeader'
import { money, longDate } from '@/app/lib/format'
import type { CustomerProfile, HistoryItem, HistoryPage } from '@/apps/directory/customer-profile'

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  arrived:     { label: 'Waiting',     cls: 'bg-yellow-900/40 text-yellow-300' },
  in_progress: { label: 'In Progress', cls: 'bg-blue-900/40 text-blue-300' },
  paused:      { label: 'Paused',      cls: 'bg-orange-900/40 text-orange-300' },
  drying:      { label: 'Drying',      cls: 'bg-teal-900/40 text-teal-300' },
  qc_ready:    { label: 'QC Ready',    cls: 'bg-purple-900/40 text-purple-300' },
  ready:       { label: 'Ready',       cls: 'bg-green-900/40 text-green-300' },
  delivered:   { label: 'Delivered',   cls: 'bg-gray-800 text-gray-400' },
  cancelled:   { label: 'Cancelled',   cls: 'bg-red-900/40 text-red-300' },
  estimate:    { label: 'Estimate',    cls: 'bg-sky-900/40 text-sky-300' },
}

function statusStyle(s: string) {
  return STATUS_STYLE[s] ?? { label: s, cls: 'bg-gray-800 text-gray-400' }
}

function dateOnly(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null
}

export default function CustomerDetail({
  profile,
  manager,
  initialHistory,
  initialVehicleHistory,
}: {
  profile: CustomerProfile
  manager: boolean
  initialHistory: HistoryPage
  initialVehicleHistory: HistoryPage
}) {
  const router = useRouter()
  const [own, setOwn] = useState(initialHistory)
  const [veh, setVeh] = useState(initialVehicleHistory)
  const [loadingMode, setLoadingMode] = useState<'own' | 'vehicle' | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const loadMore = useCallback(async (mode: 'own' | 'vehicle') => {
    if (loadingMode) return
    setLoadingMode(mode); setErr(null)
    const cur = mode === 'vehicle' ? veh : own
    try {
      const r = await fetch(`/api/customers/${profile.id}/history?mode=${mode}&offset=${cur.items.length}&limit=20`, { cache: 'no-store' })
      const d = await r.json()
      if (!r.ok || !d.ok) { setErr(d.error || 'Could not load more history.'); return }
      const merged = { ...cur, items: [...cur.items, ...(d.items as HistoryItem[])], hasMore: !!d.hasMore }
      if (mode === 'vehicle') setVeh(merged); else setOwn(merged)
    } catch { setErr('Network error — please try again.') }
    finally { setLoadingMode(null) }
  }, [profile.id, own, veh, loadingMode])

  const startOrder = useCallback(async (vehicleId: string) => {
    if (startingId) return
    setStartingId(vehicleId); setErr(null)
    try {
      const r = await fetch(`/api/customers/${profile.id}/start-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) { setErr(d.error || 'Could not start a repair order.'); setStartingId(null); return }
      router.push(`/orders/${d.orderId}`)
    } catch { setErr('Network error — please try again.'); setStartingId(null) }
  }, [profile.id, startingId, router])

  const phoneDigits = profile.phone?.replace(/[^0-9+]/g, '')

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 pb-16">
      <NavHeader back={{ href: '/customers', label: 'Customers' }} />

      <div className="mx-auto w-full max-w-2xl px-4 pt-5">
        {/* Header */}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight break-words">{profile.displayName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-gray-800 text-gray-400 border border-gray-700">{profile.customerType}</span>
            {profile.company && <span className="text-sm text-gray-400">{profile.company}</span>}
          </div>
        </div>

        {/* Contact */}
        <div className="mt-4 flex flex-wrap gap-2">
          {phoneDigits && (
            <a href={`tel:${phoneDigits}`} className="flex-1 min-w-[8rem] text-center rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 font-semibold active:bg-gray-800">
              📞 {profile.phone}
            </a>
          )}
          {profile.email && (
            <a href={`mailto:${profile.email}`} className="flex-1 min-w-[8rem] text-center rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 font-semibold active:bg-gray-800 truncate">
              ✉️ {profile.email}
            </a>
          )}
          {!phoneDigits && !profile.email && (
            <p className="text-sm text-gray-500">No contact details on file.</p>
          )}
        </div>

        {err && <p className="mt-3 text-sm text-red-400">{err}</p>}

        {/* Vehicles */}
        <section className="mt-7">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
            Vehicles {profile.vehicles.length > 0 && <span className="text-gray-600">({profile.vehicles.length})</span>}
          </h2>
          {profile.vehicles.length === 0 ? (
            <p className="text-sm text-gray-500">No vehicles linked to this customer.</p>
          ) : (
            <div className="space-y-2">
              {profile.vehicles.map((v) => {
                const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
                const extra = [v.color, v.licensePlate ? `Plate ${v.licensePlate}` : null, v.vin ? `VIN ${v.vin}` : null].filter(Boolean).join(' · ')
                return (
                  <div key={v.id} className="rounded-2xl bg-gray-900 border border-gray-800 px-4 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold leading-tight">{ymm}</p>
                      {extra && <p className="text-xs text-gray-500 mt-0.5 break-words">{extra}</p>}
                      {v.relationship && v.relationship !== 'owner' && (
                        <p className="text-[11px] text-amber-300/80 mt-0.5">Relationship: {v.relationship}</p>
                      )}
                    </div>
                    <button
                      onClick={() => startOrder(v.id)}
                      disabled={startingId === v.id}
                      className="mt-3 w-full rounded-xl bg-emerald-600 text-white font-semibold py-2.5 active:bg-emerald-700 disabled:opacity-50"
                    >
                      {startingId === v.id ? 'Starting…' : 'Start new repair order'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Own transaction history */}
        <HistorySection
          title="Repair history"
          subtitle={profile.openJobCount > 0 ? `${profile.openJobCount} open` : undefined}
          page={own}
          manager={manager}
          showFinancial
          emptyText="No repair orders or estimates authorized by this customer yet."
          loading={loadingMode === 'own'}
          onLoadMore={() => loadMore('own')}
        />

        {/* Prior/other service on this customer's vehicles — financial + authorizer stripped */}
        {veh.total > 0 && (
          <HistorySection
            title="Service on this customer's vehicles"
            note="Earlier service on these vehicles that this customer did not authorize (e.g. a previous owner). Amounts, invoices, and the other customer's details are not shown here."
            page={veh}
            manager={manager}
            showFinancial={false}
            emptyText=""
            loading={loadingMode === 'vehicle'}
            onLoadMore={() => loadMore('vehicle')}
          />
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-gray-600">
          History shows repair orders, estimates, and invoices created in Pitt Stop. Older AutoLeap
          repair orders and invoices are <span className="text-gray-500">not imported</span> — the AutoLeap
          export provides customer and vehicle details only.
        </p>
      </div>
    </main>
  )
}

function HistorySection({
  title, subtitle, note, page, manager, showFinancial, emptyText, loading, onLoadMore,
}: {
  title: string
  subtitle?: string
  note?: string
  page: HistoryPage
  manager: boolean
  showFinancial: boolean
  emptyText: string
  loading: boolean
  onLoadMore: () => void
}) {
  const items = page.items
  return (
    <section className="mt-7">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
        <span className="text-xs text-gray-600">
          {items.length} of {page.total} {page.total === 1 ? 'record' : 'records'}
          {subtitle && ` · ${subtitle}`}
        </span>
      </div>
      {note && <p className="text-[11px] text-gray-600 mb-2 leading-relaxed">{note}</p>}

      {items.length === 0 ? (
        emptyText ? <p className="text-sm text-gray-500">{emptyText}</p> : null
      ) : (
        <ol className="space-y-2">
          {items.map((it) => {
            const st = statusStyle(it.status)
            return (
              <li key={it.orderId}>
                <Link href={`/orders/${it.orderId}`} className="block rounded-2xl bg-gray-900 border border-gray-800 px-4 py-3 active:bg-gray-800">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                          {it.kind === 'estimate' ? 'Estimate' : 'Repair Order'}
                        </span>
                        <span className="text-xs text-gray-500">{it.orderNumber}</span>
                      </div>
                      <p className="text-sm font-semibold mt-1 leading-tight">{it.vehicleLabel}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {longDate(dateOnly(it.date))}
                        {showFinancial && it.authorizedBy && <> · by {it.authorizedBy}</>}
                      </p>
                    </div>
                    <div className="flex-none text-right">
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                      {showFinancial && manager && it.amountCents != null && (
                        <p className="text-sm font-semibold mt-1">{money(it.amountCents)}</p>
                      )}
                    </div>
                  </div>

                  {it.services.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {it.services.slice(0, 6).map((s, i) => (
                        <span key={i} className="max-w-full truncate text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-md">{s}</span>
                      ))}
                    </div>
                  )}

                  {showFinancial && manager && it.invoice && (
                    <div className="mt-2 text-[11px] text-sky-400">
                      Invoice{it.invoice.number ? ` #${it.invoice.number}` : ''}{it.invoice.status && it.invoice.status !== 'none' ? ` · ${it.invoice.status}` : ''}
                    </div>
                  )}
                </Link>
              </li>
            )
          })}
        </ol>
      )}

      {page.hasMore && (
        <button
          onClick={onLoadMore}
          disabled={loading}
          className="mt-3 w-full rounded-xl border border-gray-700 text-gray-300 font-semibold py-3 active:bg-gray-900 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load older records'}
        </button>
      )}
    </section>
  )
}

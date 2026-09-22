'use client'

/**
 * Discreet global operational search.
 *
 * A small magnifier control (in NavHeader / the home header) that opens a command-palette overlay — it
 * never occupies permanent home-screen space. Phone + desktop friendly: full-width sheet on mobile, a
 * centered panel on desktop, Cmd/Ctrl+K to open, Esc / backdrop to close, arrow keys + Enter to pick.
 *
 * It debounces input, requires a minimum length before querying, shows nothing until the operator types
 * (no pre-emptive recent/sensitive suggestions), and groups results by category. All authorization is
 * enforced server-side by /api/search — this UI only renders what the endpoint already allowed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Result {
  category: string
  id: string
  href: string | null
  title: string
  subtitle: string
  meta?: string
  badge?: string
  phone?: string
}
interface Group { category: string; label: string; results: Result[] }

const MIN_LEN = 2
const DEBOUNCE_MS = 250

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export default function GlobalSearch({ label = false }: { label?: boolean }) {
  const [open, setOpen] = useState(false)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

  // Cmd/Ctrl+K toggles the palette from anywhere (doesn't fire while typing in another field's shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className="flex min-h-11 shrink-0 items-center gap-2 text-gray-300 hover:text-white font-medium"
      >
        <SearchIcon />
        {label && <span>Search</span>}
        <span className="hidden sm:inline text-[10px] text-gray-500 border border-gray-700 rounded px-1 py-0.5 leading-none">{isMac ? '⌘K' : 'Ctrl K'}</span>
      </button>
      {open && <SearchOverlay onClose={() => setOpen(false)} />}
    </>
  )
}

function SearchOverlay({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Flat list of navigable/actionable results for keyboard selection.
  const flat = useMemo(() => groups.flatMap((g) => g.results), [groups])

  useEffect(() => { inputRef.current?.focus() }, [])
  // Lock background scroll while the palette is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Debounced fetch. Min length gate; cancels the prior in-flight request so results never race. All
  // state updates happen inside the async callback (never synchronously in the effect body) — the render
  // gate on query length shows the idle prompt, so we don't need to churn state on every short query.
  useEffect(() => {
    const query = q.trim()
    if (query.length < MIN_LEN) { abortRef.current?.abort(); return }
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setLoading(true)
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal, cache: 'no-store' })
        if (r.status === 401) { setError('Sign in required'); setGroups([]); setSearched(true); return }
        const data = await r.json()
        if (!data.ok) { setError(data.error || 'Search failed'); setGroups([]); setSearched(true); return }
        setGroups(data.groups || []); setTruncated(!!data.truncated); setError(null); setSearched(true); setActive(0)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setError('Search failed'); setGroups([]); setSearched(true)
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])

  const choose = useCallback((r: Result | undefined) => {
    if (!r) return
    if (r.href) { onClose(); router.push(r.href) }
    else if (r.phone) { window.location.href = `tel:${r.phone.replace(/[^0-9+]/g, '')}` }
  }, [onClose, router])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(0, flat.length - 1))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active]) }
  }

  // Running offset per group → each result's global index (for keyboard highlight) without mutating
  // during the render callback.
  const groupOffsets = useMemo(() => {
    const offs: number[] = []
    let acc = 0
    for (const g of groups) { offs.push(acc); acc += g.results.length }
    return offs
  }, [groups])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center" role="dialog" aria-modal="true" aria-label="Search Pitt Stop OS">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-2xl mt-0 sm:mt-24 h-full sm:h-auto sm:max-h-[70vh] flex flex-col bg-gray-900 sm:rounded-2xl border border-gray-800 shadow-2xl overflow-hidden">
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 shrink-0">
          <SearchIcon className="text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search customers, vehicles, jobs, VIN, phone, stock #…"
            className="min-w-0 flex-1 bg-transparent text-white placeholder-gray-500 outline-none text-base"
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            enterKeyHint="search" inputMode="search" maxLength={100}
          />
          <button type="button" onClick={onClose} aria-label="Close search" className="text-gray-500 hover:text-gray-300 text-sm shrink-0">Esc</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {q.trim().length < MIN_LEN ? (
            <div className="px-4 py-10 text-center text-gray-500 text-sm">Type at least {MIN_LEN} characters to search.</div>
          ) : loading && !searched ? (
            <div className="px-4 py-10 text-center text-gray-500 text-sm">Searching…</div>
          ) : error ? (
            <div className="px-4 py-10 text-center text-amber-400/80 text-sm">{error}</div>
          ) : flat.length === 0 && searched ? (
            <div className="px-4 py-10 text-center text-gray-500 text-sm">No matching customers, vehicles, jobs, or services.</div>
          ) : (
            <div className="py-2">
              {groups.map((g, gi) => (
                <div key={g.category} className="mb-1">
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{g.label}</div>
                  {g.results.map((r, ri) => {
                    const idx = groupOffsets[gi] + ri
                    const isActive = idx === active
                    const clickable = !!r.href || !!r.phone
                    return (
                      <button
                        key={`${r.category}:${r.id}`}
                        type="button"
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => choose(r)}
                        disabled={!clickable}
                        className={`w-full text-left px-4 py-2.5 flex items-start gap-3 ${isActive ? 'bg-gray-800' : ''} ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-white text-sm font-medium truncate">{r.title}</span>
                            {r.badge && <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-700 rounded-full px-1.5 py-0.5 shrink-0">{r.badge}</span>}
                          </div>
                          <div className="text-gray-400 text-xs truncate">{r.subtitle}</div>
                          {r.meta && <div className="text-gray-500 text-xs truncate">{r.meta}</div>}
                        </div>
                        {!r.href && r.phone && <span className="text-blue-400 text-xs shrink-0 self-center">Call</span>}
                      </button>
                    )
                  })}
                </div>
              ))}
              {truncated && <div className="px-4 py-3 text-center text-gray-600 text-xs">More results exist — refine your search.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

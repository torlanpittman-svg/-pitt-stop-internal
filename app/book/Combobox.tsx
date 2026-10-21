'use client'

/**
 * Searchable dropdown (ARIA 1.2 combobox + listbox). Typing filters the list; only a value FROM the list can
 * be chosen — leaving the field with unmatched text restores the previous choice. Keyboard: ↓/↑ move,
 * Enter selects, Escape closes. Rows are 44px+ for touch.
 */
import { useId, useMemo, useRef, useState } from 'react'

export default function Combobox({ label, options, value, onChange, disabled, loading, placeholder, error, hint, emptyText, inputMode, id: idProp }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void
  disabled?: boolean; loading?: boolean; placeholder?: string; error?: string; hint?: string; emptyText?: string
  inputMode?: 'numeric' | 'text'; id?: string
}) {
  const auto = useId()
  const id = idProp ?? `cb${auto}`
  const listId = `${id}-list`
  const [text, setText] = useState<string | null>(null) // null = not editing; show `value`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const query = (text ?? '').trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!query) return options
    const starts: string[] = []; const has: string[] = []
    for (const o of options) {
      const l = o.toLowerCase()
      if (l.startsWith(query)) starts.push(o)
      else if (l.includes(query)) has.push(o)
    }
    return [...starts, ...has]
  }, [options, query])

  function choose(v: string) {
    onChange(v)
    setText(null); setOpen(false)
  }
  function commitOrRevert() {
    if (text != null) {
      const exact = options.find((o) => o.toLowerCase() === text.trim().toLowerCase())
      if (exact && exact !== value) onChange(exact)
    }
    setText(null); setOpen(false)
  }
  function scrollTo(i: number) {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); setActive(Math.max(0, filtered.indexOf(value))); return }
      const n = filtered.length; if (!n) return
      const next = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n
      setActive(next); scrollTo(next)
    } else if (e.key === 'Enter') {
      if (open && filtered[active]) { e.preventDefault(); choose(filtered[active]) }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setText(null); setOpen(false) }
    } else if (e.key === 'Tab') {
      commitOrRevert()
    }
  }

  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined
  const showList = open && !disabled && !loading

  return (
    <div className="relative">
      <label htmlFor={id} className="block text-[0.95rem] font-medium text-[var(--ps-ink)]">{label}</label>
      <div className="relative mt-1.5">
        <input
          ref={inputRef} id={id} type="text" role="combobox" autoComplete="off" autoCapitalize="off" spellCheck={false}
          inputMode={inputMode} enterKeyHint="done"
          aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={showList && filtered[active] ? `${id}-opt-${active}` : undefined}
          aria-invalid={error ? true : undefined} aria-describedby={describedBy}
          className="ps-field pr-11" disabled={disabled}
          placeholder={loading ? 'Loading…' : placeholder}
          value={text ?? value}
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => { setOpen(true); setActive(Math.max(0, filtered.indexOf(value))) }}
          onClick={() => setOpen(true)}
          onBlur={commitOrRevert}
          onKeyDown={onKeyDown}
        />
        <button type="button" tabIndex={-1} aria-hidden disabled={disabled}
          onMouseDown={(e) => { e.preventDefault(); if (open) { setOpen(false) } else { inputRef.current?.focus(); setOpen(true) } }}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[var(--ps-muted)] disabled:opacity-40">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden><path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {showList && (
        <ul ref={listRef} id={listId} role="listbox" aria-label={label}
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto overscroll-contain rounded-xl border border-[var(--ps-line)] bg-white py-1 shadow-[0_12px_32px_rgba(2,52,86,.18)]">
          {filtered.length ? filtered.map((o, i) => (
            <li key={o} id={`${id}-opt-${i}`} data-i={i} role="option" aria-selected={o === value}
              onMouseDown={(e) => { e.preventDefault(); choose(o) }}
              onMouseMove={() => active !== i && setActive(i)}
              className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3.5 text-[0.98rem] ${i === active ? 'bg-[#eef4f9]' : ''} ${o === value ? 'font-semibold text-[var(--ps-navy)]' : ''}`}>
              <span className="min-w-0 break-words">{o}</span>
              {o === value && <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden><path d="M4 10.5 8 14.5 16 6" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </li>
          )) : (
            <li role="option" aria-selected={false} aria-disabled className="px-3.5 py-3 text-sm text-[var(--ps-body)]">{emptyText ?? 'No matches. Check the spelling, or call us for help.'}</li>
          )}
        </ul>
      )}
      {hint && !error && <p id={`${id}-hint`} className="mt-1.5 text-sm text-[var(--ps-body)]">{hint}</p>}
      {error && <p id={`${id}-err`} className="mt-1.5 text-sm font-medium text-[var(--ps-error)]">{error}</p>}
    </div>
  )
}

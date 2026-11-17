'use client'
/**
 * The main view links to detail that lives inside collapsed <details> sections. A plain #anchor does not open
 * a closed section in every browser, so this opens every <details> around the target and scrolls to it.
 */
import { useEffect } from 'react'

export default function OpenOnHash() {
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1))
      if (!id) return
      const el = document.getElementById(id)
      if (!el) return
      for (let n: HTMLElement | null = el; n; n = n.parentElement) if (n instanceof HTMLDetailsElement) n.open = true
      el.scrollIntoView({ block: 'start' })
    }
    open()
    window.addEventListener('hashchange', open)
    return () => window.removeEventListener('hashchange', open)
  }, [])
  return null
}

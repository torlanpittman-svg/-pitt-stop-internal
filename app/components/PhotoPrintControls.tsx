'use client'

import { useState } from 'react'

export default function PhotoPrintControls({ backHref }: { backHref: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function print() {
    setBusy(true); setError('')
    try {
      await Promise.all(Array.from(document.querySelectorAll<HTMLImageElement>('img.photo-evidence')).map((img) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Photo loading timed out.')), 20000)
          img.decode().then(resolve, reject).finally(() => clearTimeout(timer))
        })))
      window.print()
    } catch { setError('Some photos have not loaded. Refresh this page and try again before saving the PDF.') }
    finally { setBusy(false) }
  }
  return <div className="photo-print-controls" style={{ marginBottom: 20 }}>
    <a href={backHref} style={{ color: '#2563eb', marginRight: 20 }}>Back to vehicle</a>
    <button disabled={busy} onClick={print} style={{ background: '#2563eb', color: '#fff', padding: '12px 18px', borderRadius: 10, fontWeight: 600 }}>{busy ? 'Loading photos…' : 'Print / Save PDF'}</button>
    <p style={{ fontSize: 13, color: '#555', marginTop: 10 }}>Choose Save as PDF in the print dialog to attach this document to an estimate, invoice, or insurance claim.</p>
    {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
  </div>
}

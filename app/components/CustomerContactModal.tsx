'use client'

import { useEffect, useState } from 'react'

interface Contact { customer: string | null; phone: string | null; email: string | null; source: string }

/** Clean, simple customer-contact popup for the Work Board + Job detail. Read-only;
 *  phone → tel:, email → mailto:, with copy. Missing fields show "Not available" (the
 *  panel never hides just because one field is blank). No pricing/accounting data. */
export default function CustomerContactModal({ orderId, customerName, onClose }: { orderId: string; customerName: string; onClose: () => void }) {
  const [c, setC] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let ok = true
    fetch(`/api/workflow/orders/${orderId}/contact`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (ok && d.ok) setC({ customer: d.customer, phone: d.phone, email: d.email, source: d.source }) })
      .catch(() => {})
      .finally(() => { if (ok) setLoading(false) })
    return () => { ok = false }
  }, [orderId])

  const fmtPhone = (p: string) => { const d = p.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1'); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p }
  const copy = (label: string, val: string) => { navigator.clipboard?.writeText(val).then(() => { setCopied(label); setTimeout(() => setCopied(null), 1500) }).catch(() => {}) }
  const phone = c?.phone?.trim() || null
  const email = c?.email?.trim() || null

  return (
    <div className="fixed inset-0 z-[70] flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-xl">Customer contact</h2>
          <button onClick={onClose} className="text-gray-500 text-sm">Close</button>
        </div>

        <p className="text-gray-500 text-xs uppercase tracking-widest">Customer</p>
        <p className="text-white text-lg font-semibold mb-4">{c?.customer || customerName}</p>

        {loading ? (
          <p className="text-gray-500 text-sm py-4">Loading…</p>
        ) : (
          <>
            {/* Phone */}
            <p className="text-gray-500 text-xs uppercase tracking-widest">Phone</p>
            {phone ? (
              <div className="flex items-center gap-2 mt-1 mb-4">
                <span className="text-white text-lg tabular-nums flex-1">{fmtPhone(phone)}</span>
                <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-xl active:opacity-80">Call</a>
                <button onClick={() => copy('phone', fmtPhone(phone))} className="text-gray-400 text-sm border border-gray-700 px-3 py-2 rounded-xl active:opacity-70">{copied === 'phone' ? '✓' : 'Copy'}</button>
              </div>
            ) : <p className="text-gray-500 mt-1 mb-4">Not available</p>}

            {/* Email */}
            <p className="text-gray-500 text-xs uppercase tracking-widest">Email</p>
            {email ? (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-white text-base truncate flex-1">{email}</span>
                <a href={`mailto:${email}`} className="bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-xl active:opacity-80">Email</a>
                <button onClick={() => copy('email', email)} className="text-gray-400 text-sm border border-gray-700 px-3 py-2 rounded-xl active:opacity-70">{copied === 'email' ? '✓' : 'Copy'}</button>
              </div>
            ) : <p className="text-gray-500 mt-1">Not available</p>}
          </>
        )}
      </div>
    </div>
  )
}

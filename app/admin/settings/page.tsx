/**
 * Minimal admin settings — view/edit shop-wide business rules (fees, tax). Server
 * component + server action, so it's covered by the existing /admin basic-auth
 * (proxy.ts) with no new API surface. Values resolve DB → env → default.
 */
import { getAllSettings, updateSetting, SETTINGS } from '@/apps/settings/db'
import { revalidatePath } from 'next/cache'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

async function saveSettings(formData: FormData) {
  'use server'
  for (const def of Object.values(SETTINGS)) {
    const raw = def.type === 'bool' ? formData.get(def.key) === 'on' : formData.get(def.key)
    if (raw === null && def.type !== 'bool') continue
    await updateSetting(def.key, raw, 'admin')
  }
  revalidatePath('/admin/settings')
}

export default async function SettingsPage() {
  const settings = await getAllSettings()
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-6 py-8 max-w-2xl mx-auto">
      <Link href="/admin" className="text-gray-500 text-sm block mb-6 hover:text-gray-300">← Admin</Link>
      <h1 className="text-white font-bold text-2xl mb-1">Business Settings</h1>
      <p className="text-gray-500 text-sm mb-6">
        Fees appear as explicit lines on manager estimates, separate from tax. Card processing is disabled until confirmed.
        Rates are in basis points (300 = 3.00%); the shop-supplies cap is in cents (2000 = $20.00).
      </p>

      <form action={saveSettings} className="space-y-5">
        {settings.map((s) => (
          <div key={s.key} className="flex items-start justify-between gap-4 border-b border-gray-900 pb-4">
            <div className="min-w-0">
              <label htmlFor={s.key} className="text-white font-medium text-sm">{s.label}</label>
              {s.description && <p className="text-gray-500 text-xs mt-0.5">{s.description}</p>}
              <p className="text-gray-700 text-[10px] mt-1 font-mono">{s.key}</p>
            </div>
            {s.type === 'bool' ? (
              <input id={s.key} name={s.key} type="checkbox" defaultChecked={!!s.value}
                className="mt-1 h-6 w-6 shrink-0 accent-blue-600" />
            ) : (
              <input id={s.key} name={s.key} type="number" defaultValue={String(s.value)}
                className="w-28 shrink-0 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-right text-white" />
            )}
          </div>
        ))}
        <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl">
          Save settings
        </button>
      </form>
    </main>
  )
}

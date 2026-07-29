/**
 * READ-ONLY: query the connected company for Sterling dealers and list a sample
 * of existing customers. Auto-detects which API host authorizes the token so it
 * reports against whatever environment is actually connected. No writes.
 */
import { neon } from '@neondatabase/serverless'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadEnv() {
  for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
    let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1)
    if (!process.env[m[1]]) process.env[m[1]] = v
  }
}
function decrypt(p, keyHex) {
  const [ver, iv, tag, ct] = p.split(':'); if (ver !== 'v1') throw new Error('bad ver')
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}
async function query(base, realm, token, q) {
  const url = `${base}/v3/company/${realm}/query?query=${encodeURIComponent(q)}&minorversion=73`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  return { status: res.status, json: res.status === 200 ? await res.json() : await res.text() }
}

async function main() {
  loadEnv()
  const sql = neon(process.env.DATABASE_URL)
  const [row] = await sql.query(`SELECT realm_id, access_token_enc FROM qb_connections WHERE status='active' ORDER BY updated_at DESC LIMIT 1`)
  const token = decrypt(row.access_token_enc, process.env.QUICKBOOKS_ENCRYPTION_KEY)
  const realm = row.realm_id

  // Detect which host authorizes.
  let base = null
  for (const b of ['https://quickbooks.api.intuit.com', 'https://sandbox-quickbooks.api.intuit.com']) {
    const r = await query(b, realm, token, 'select Id from CompanyInfo')
    if (r.status === 200) { base = b; break }
  }
  if (!base) { console.log('Token authorized against neither host.'); return }
  console.log(`Authorized host: ${base}`)
  console.log(`(${base.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'} company)\n`)

  const ster = await query(base, realm, token, "select * from Customer where DisplayName like '%Sterling%'")
  const sterList = ster.json?.QueryResponse?.Customer ?? []
  console.log(`Customers matching "Sterling": ${sterList.length}`)
  for (const c of sterList) console.log(`  - ${c.DisplayName} (Id ${c.Id})`)

  const all = await query(base, realm, token, 'select * from Customer maxresults 15')
  const allList = all.json?.QueryResponse?.Customer ?? []
  console.log(`\nSample of existing customers (up to 15): ${allList.length}`)
  for (const c of allList) console.log(`  - ${c.DisplayName} (Id ${c.Id})`)
}
main().catch((e) => { console.error(e); process.exit(1) })

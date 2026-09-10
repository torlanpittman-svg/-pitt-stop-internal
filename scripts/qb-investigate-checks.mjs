/**
 * READ-ONLY QuickBooks investigation for the Write-a-Check feature.
 *
 * Reports (NO writes):
 *   - which host authorizes the active token (prod vs sandbox) + company name
 *   - all Bank-type accounts (to locate American Momentum operating *2649)
 *   - all expense accounts (for business-category → account mapping)
 *   - recent Purchase transactions with PaymentType=Check (check-number/DocNumber pattern)
 *   - a sample of Vendors (payee resolution)
 *
 * Never prints full account numbers; masks anything that looks like one.
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
// Mask any 5+ digit run so a real account number can never land in logs.
const mask = (s) => String(s ?? '').replace(/\d{5,}/g, (m) => '****' + m.slice(-4))
async function query(base, realm, token, q) {
  const url = `${base}/v3/company/${realm}/query?query=${encodeURIComponent(q)}&minorversion=73`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  return { status: res.status, json: res.status === 200 ? await res.json() : await res.text() }
}

async function main() {
  loadEnv()
  const sql = neon(process.env.DATABASE_URL)
  const [row] = await sql.query(`SELECT realm_id, access_token_enc, environment FROM qb_connections WHERE status='active' ORDER BY updated_at DESC LIMIT 1`)
  if (!row) { console.log('No active QB connection.'); return }
  const token = decrypt(row.access_token_enc, process.env.QUICKBOOKS_ENCRYPTION_KEY)
  const realm = row.realm_id

  let base = null
  for (const b of ['https://quickbooks.api.intuit.com', 'https://sandbox-quickbooks.api.intuit.com']) {
    const r = await query(b, realm, token, 'select Id from CompanyInfo')
    if (r.status === 200) { base = b; break }
  }
  if (!base) { console.log('Token authorized against neither host.'); return }
  const ci = await query(base, realm, token, 'select * from CompanyInfo')
  const company = ci.json?.QueryResponse?.CompanyInfo?.[0]
  console.log(`Authorized host: ${base}  (${base.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'})`)
  console.log(`Company: ${company?.CompanyName ?? '?'} (realm ${realm}, env col=${row.environment})\n`)

  // ── Bank accounts ──
  const banks = await query(base, realm, token, "select * from Account where AccountType = 'Bank'")
  const bankList = banks.json?.QueryResponse?.Account ?? []
  console.log(`=== Bank accounts (${bankList.length}) ===`)
  for (const a of bankList) {
    console.log(`  Id ${a.Id} | "${a.Name}" | subtype=${a.AccountSubType} | acct#=${mask(a.AcctNum)} | balance=${a.CurrentBalance} | active=${a.Active}`)
  }

  // ── Expense accounts ──
  const exp = await query(base, realm, token, "select * from Account where AccountType = 'Expense' maxresults 60")
  const expList = exp.json?.QueryResponse?.Account ?? []
  console.log(`\n=== Expense accounts (${expList.length}) ===`)
  for (const a of expList) console.log(`  Id ${a.Id} | "${a.Name}" | subtype=${a.AccountSubType}`)

  // ── Recent Purchases (checks live here as PaymentType=Check) ──
  const pur = await query(base, realm, token, 'select * from Purchase ORDERBY MetaData.CreateTime DESC maxresults 30')
  const purList = pur.json?.QueryResponse?.Purchase ?? []
  const checks = purList.filter((p) => p.PaymentType === 'Check')
  console.log(`\n=== Recent Purchase txns (${purList.length}; of those PaymentType=Check: ${checks.length}) ===`)
  for (const p of purList.slice(0, 20)) {
    console.log(`  Id ${p.Id} | ${p.PaymentType} | DocNumber=${p.DocNumber ?? '(none)'} | acct=${p.AccountRef?.name} | payee=${p.EntityRef?.name ?? '-'} | ${p.TxnDate} | $${p.TotalAmt}`)
  }
  // Highest numeric check DocNumber (to understand the sequence).
  let maxCheck = 0
  for (const p of checks) { const n = parseInt(String(p.DocNumber ?? '').replace(/\D/g, ''), 10); if (Number.isFinite(n) && n > maxCheck) maxCheck = n }
  console.log(`  Highest numeric check DocNumber seen (last 30): ${maxCheck || '(none)'}`)

  // ── Vendors sample ──
  const ven = await query(base, realm, token, 'select * from Vendor maxresults 15')
  const venList = ven.json?.QueryResponse?.Vendor ?? []
  const venCount = await query(base, realm, token, 'select count(*) from Vendor')
  console.log(`\n=== Vendors (showing ${venList.length}) ===`)
  for (const v of venList) console.log(`  Id ${v.Id} | "${v.DisplayName}" | active=${v.Active}`)
  console.log(`  Total vendor count: ${JSON.stringify(venCount.json?.QueryResponse?.totalCount ?? '?')}`)
}
main().catch((e) => { console.error(e); process.exit(1) })

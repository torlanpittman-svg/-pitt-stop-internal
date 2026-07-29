/**
 * READ-ONLY diagnostic: decrypt the stored QB access token and call the
 * companyinfo endpoint against BOTH the production and sandbox API hosts.
 * Whichever authorizes tells us which environment the token/app belongs to.
 * Makes no changes in QuickBooks or the DB.
 */
import { neon } from '@neondatabase/serverless'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadEnv() {
  const raw = readFileSync(join(ROOT, '.env.local'), 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!process.env[m[1]]) process.env[m[1]] = v
  }
}

function decrypt(payload, keyHex) {
  const [ver, iv, tag, ct] = payload.split(':')
  if (ver !== 'v1') throw new Error('bad payload version')
  const key = Buffer.from(keyHex, 'hex')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

async function callCompanyInfo(base, realm, token) {
  const url = `${base}/v3/company/${realm}/companyinfo/${realm}?minorversion=73`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  const serverDate = res.headers.get('date')
  const body = await res.text()
  return { status: res.status, serverDate, body: body.slice(0, 400) }
}

async function main() {
  loadEnv()
  const sql = neon(process.env.DATABASE_URL)
  const rows = await sql.query(
    `SELECT realm_id, environment, access_token_enc FROM qb_connections WHERE status='active' ORDER BY updated_at DESC LIMIT 1`
  )
  if (!rows.length) { console.log('No active connection.'); return }
  const { realm_id, environment, access_token_enc } = rows[0]
  const token = decrypt(access_token_enc, process.env.QUICKBOOKS_ENCRYPTION_KEY)

  console.log(`Realm: ${realm_id}`)
  console.log(`Stored environment: ${environment}`)
  console.log(`Access token: ${token.slice(0, 12)}…${token.slice(-6)} (len ${token.length})\n`)

  for (const [name, base] of [
    ['PRODUCTION', 'https://quickbooks.api.intuit.com'],
    ['SANDBOX',    'https://sandbox-quickbooks.api.intuit.com'],
  ]) {
    process.stdout.write(`--- ${name} (${base}) ---\n`)
    try {
      const r = await callCompanyInfo(base, realm_id, token)
      console.log(`  HTTP ${r.status} | server date: ${r.serverDate}`)
      console.log(`  body: ${r.body}\n`)
    } catch (e) {
      console.log(`  request error: ${e}\n`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

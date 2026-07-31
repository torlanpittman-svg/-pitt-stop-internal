/**
 * Securely load production QuickBooks keys into Vercel (production env only).
 *
 * Reads .env.prod-keys (git-ignored), writes QUICKBOOKS_CLIENT_ID and
 * QUICKBOOKS_CLIENT_SECRET to the Vercel production environment via `vercel env
 * add` (value piped over stdin), then deletes the file. NEVER prints the values —
 * only their lengths, so nothing sensitive reaches logs, terminal, or chat.
 *
 * Production secrets live only in Vercel (the production environment), not in
 * .env.local, so sandbox (local) and production can never be confused.
 *
 *   node scripts/ingest-prod-keys.mjs
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEYS_FILE = join(ROOT, '.env.prod-keys')
const SCOPE = 'team_TGngJQMpvAgMrRXyILLlPNk6'

function parseEnv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

function vercel(args, input) {
  const res = spawnSync('npx', ['vercel', ...args, '--scope', SCOPE], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  })
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }
}

function setProdVar(name, value) {
  // Remove any existing value first (ignore errors), then add fresh.
  vercel(['env', 'rm', name, 'production', '--yes'])
  const { code, out } = vercel(['env', 'add', name, 'production'], value)
  // Never print `value`; only report name + length + coarse result.
  const ok = code === 0 || /added|created|success/i.test(out)
  console.log(`  ${name}: len=${value.length} → ${ok ? 'set in Vercel production' : 'FAILED'}`)
  if (!ok) console.log(`    (vercel output: ${out.split('\n').slice(-3).join(' ').slice(0, 200)})`)
  return ok
}

function main() {
  if (!existsSync(KEYS_FILE)) {
    console.error('Missing .env.prod-keys — create it first (see instructions).')
    process.exit(1)
  }
  const env = parseEnv(readFileSync(KEYS_FILE, 'utf8'))
  const id = env.QUICKBOOKS_CLIENT_ID
  const secret = env.QUICKBOOKS_CLIENT_SECRET

  const problems = []
  if (!id) problems.push('QUICKBOOKS_CLIENT_ID missing')
  if (!secret) problems.push('QUICKBOOKS_CLIENT_SECRET missing')
  // Basic sanity without revealing anything.
  if (id && id.length < 20) problems.push('CLIENT_ID looks too short')
  if (secret && secret.length < 20) problems.push('CLIENT_SECRET looks too short')
  if (problems.length) {
    console.error('Problems: ' + problems.join('; '))
    process.exit(1)
  }

  console.log('Loading production keys into Vercel (production)…')
  const a = setProdVar('QUICKBOOKS_CLIENT_ID', id)
  const b = setProdVar('QUICKBOOKS_CLIENT_SECRET', secret)

  // Always delete the local secret file, success or fail.
  try { unlinkSync(KEYS_FILE) ; console.log('Deleted .env.prod-keys ✓') }
  catch (e) { console.log('WARNING: could not delete .env.prod-keys — remove it manually.') }

  if (!a || !b) process.exit(1)
  console.log('Done. Production Client ID + Secret are in Vercel production only.')
}

main()

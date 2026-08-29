/**
 * Securely load the Auto.dev plate-lookup API key into Vercel and enable the
 * feature. Reads .env.plate-key (git-ignored), sets AUTODEV_API_KEY +
 * PLATE_LOOKUP_ENABLED=true in the Vercel Production AND Preview environments via
 * `vercel env add` (value piped over stdin), then deletes the file.
 *
 * NEVER prints the key — only its length — so nothing sensitive reaches logs,
 * the terminal, or chat.
 *
 *   node scripts/ingest-plate-key.mjs
 *
 * .env.plate-key format:
 *   AUTODEV_API_KEY=xxxxxxxx
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEYS_FILE = join(ROOT, '.env.plate-key')
const SCOPE = 'team_TGngJQMpvAgMrRXyILLlPNk6'
const ENVS = ['production', 'preview']

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
  const res = spawnSync('npx', ['--yes', 'vercel', ...args, '--scope', SCOPE], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache || join(ROOT, '.npm-cache') },
  })
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }
}

function setVar(name, value, env, { secret = false } = {}) {
  vercel(['env', 'rm', name, env, '--yes'])                 // remove existing (ignore errors)
  const { code, out } = vercel(['env', 'add', name, env], value)
  const ok = code === 0 || /added|created|success/i.test(out)
  // Never print secret values; only name + length + coarse result.
  console.log(`  ${name} [${env}]: ${secret ? `len=${value.length}` : `="${value}"`} → ${ok ? 'set' : 'FAILED'}`)
  if (!ok) console.log(`    (vercel: ${out.split('\n').slice(-3).join(' ').slice(0, 200)})`)
  return ok
}

function main() {
  if (!existsSync(KEYS_FILE)) {
    console.error('Missing .env.plate-key — create it with:  AUTODEV_API_KEY=<your key>')
    process.exit(1)
  }
  const env = parseEnv(readFileSync(KEYS_FILE, 'utf8'))
  const key = env.PLATETOVIN_API_KEY || env.AUTODEV_API_KEY
  const name = env.PLATETOVIN_API_KEY ? 'PLATETOVIN_API_KEY' : 'AUTODEV_API_KEY'
  if (!key || key.length < 12) { console.error('PLATETOVIN_API_KEY (or AUTODEV_API_KEY) missing or too short in .env.plate-key'); process.exit(1) }

  console.log(`Configuring plate lookup in Vercel (Production + Preview) via ${name}…`)
  let ok = true
  for (const e of ENVS) {
    ok = setVar(name, key, e, { secret: true }) && ok
    ok = setVar('PLATE_LOOKUP_PROVIDER', name === 'PLATETOVIN_API_KEY' ? 'platetovin' : 'auto_dev', e) && ok
    ok = setVar('PLATE_LOOKUP_ENABLED', 'true', e) && ok
  }

  try { unlinkSync(KEYS_FILE); console.log('Deleted .env.plate-key ✓') }
  catch { console.log('WARNING: could not delete .env.plate-key — remove it manually.') }

  if (!ok) process.exit(1)
  console.log('Done. Key stored in Vercel only; feature flag enabled. Redeploy to apply.')
}

main()

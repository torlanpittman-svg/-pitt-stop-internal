/**
 * Securely set an employee's role (and optionally an elevation PIN) directly in
 * the DB. Owner-run on a trusted machine (reads DATABASE_URL from .env.local).
 * Manager/admin PINs are never set via a public endpoint.
 *
 *   node scripts/set-employee-role.mjs "<name>" <employee|manager|admin> [4-digit-pin]
 *
 * The PIN is hashed with scrypt (same format as apps/workflow/identity.ts) and
 * only the hash is stored. The plaintext PIN is never persisted or printed.
 */
import { readFileSync } from 'node:fs'
import { scryptSync, randomBytes } from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
function dbUrl() {
  const raw = readFileSync(join(ROOT, '.env.local'), 'utf8')
  const line = raw.split('\n').find((l) => l.startsWith('DATABASE_URL='))
  return line?.slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '')
}
function hashPin(pin) {
  const salt = randomBytes(16).toString('hex')
  const dk = scryptSync(String(pin), salt, 32).toString('hex')
  return `scrypt$${salt}$${dk}`
}

const [, , name, role, pin] = process.argv
if (!name || !['employee', 'manager', 'admin'].includes(role || '')) {
  console.error('usage: node scripts/set-employee-role.mjs "<name>" <employee|manager|admin> [pin]')
  process.exit(1)
}
if ((role === 'manager' || role === 'admin') && pin && !/^\d{4,8}$/.test(pin)) {
  console.error('pin must be 4–8 digits'); process.exit(1)
}

const sql = neon(dbUrl())
const rows = await sql`select id, name from employees where lower(name) = lower(${name}) and active = true`
if (rows.length === 0) { console.error(`No active employee named "${name}". Add them in /admin/workflow first.`); process.exit(1) }
if (rows.length > 1) { console.error(`Multiple employees named "${name}" — rename to disambiguate.`); process.exit(1) }
const id = rows[0].id

if (pin) {
  await sql`update employees set role = ${role}, pin_hash = ${hashPin(pin)} where id = ${id}`
  console.log(`Set ${rows[0].name} → role=${role}, PIN set (hash only stored).`)
} else {
  await sql`update employees set role = ${role} where id = ${id}`
  console.log(`Set ${rows[0].name} → role=${role} (PIN unchanged).`)
}

#!/usr/bin/env node
/**
 * Pitt Stop PRINT BRIDGE agent — the permanent, always-on link between the Pitt Stop OS cloud print
 * queue and the shop's Brother HL-L2420DW. Runs unattended on the always-on shop laptop (macOS or
 * Windows). The same script runs on the MacBook TODAY as a temporary bridge — no code changes to move it.
 *
 * Loop:  POST /api/print-bridge/claim  → if a job, decode its PDF, print it, POST /api/print-bridge/result.
 * Safety:
 *   - Authenticates with PRINT_BRIDGE_TOKEN (Bearer). Pulls ONLY Pitt Stop print jobs.
 *   - The server hands out each job to exactly one bridge (atomic, skip-locked) → no duplicate prints.
 *   - Every poll is also the bridge's HEARTBEAT (id, version, start time) so the app can show it online.
 *   - It reports what it actually knows: 'submitted' (the printer driver accepted the job — NOT proof of
 *     paper; a manager confirms that in the app), 'failed' (nothing will print), or 'uncertain'.
 *     On Windows it watches the print spooler: a job the printer never takes is cancelled and reported
 *     failed instead of printing by surprise later.
 *   - The check PDF exists on disk only while printing and is deleted afterwards (and on startup).
 *   - Queued jobs expire server-side, so an outage never causes a late, unattended print.
 *   - No business logic, no arbitrary commands — it prints bytes and reports status.
 *
 * Config (env OR a print-bridge.config.json next to this script; env wins):
 *   PITTSTOP_BASE_URL   e.g. https://your-pitt-stop-os.vercel.app   (required)
 *   PRINT_BRIDGE_TOKEN  the shared bridge secret                     (required, matches server env)
 *   PRINTER_NAME        CUPS/Windows printer name  (default: Brother_HL_L2420DW)
 *   BRIDGE_ID           identifier for logs        (default: hostname)
 *   POLL_SECONDS        idle poll interval         (default: 5)
 *   SUMATRA_PATH        Windows only: path to SumatraPDF.exe for silent PDF printing
 *   SPOOL_WAIT_SECONDS  Windows only: how long to wait for the printer to take a job (default: 75)
 *
 * Usage:  node scripts/print-bridge.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE_VERSION = '2.0.0'
const STARTED_AT = new Date().toISOString()
const TMP_PREFIX = 'pittstop-check-'

function loadConfig() {
  const cfg = {}
  const file = join(HERE, 'print-bridge.config.json')
  // Strip a leading UTF-8 BOM — Windows PowerShell's Set-Content -Encoding UTF8 writes one, and
  // JSON.parse rejects it. Without this the config silently fails to load and the bridge exits.
  if (existsSync(file)) { try { Object.assign(cfg, JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))) } catch (e) { console.error('bad config json:', e.message) } }
  const get = (k, d) => process.env[k] ?? cfg[k] ?? d
  return {
    baseUrl: (get('PITTSTOP_BASE_URL', '') || '').replace(/\/$/, ''),
    token: get('PRINT_BRIDGE_TOKEN', ''),
    printer: get('PRINTER_NAME', 'Brother_HL_L2420DW'),
    bridgeId: get('BRIDGE_ID', hostname()),
    pollMs: Math.max(2, parseInt(get('POLL_SECONDS', '5'), 10) || 5) * 1000,
    sumatra: get('SUMATRA_PATH', 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe'),
    spoolWaitSeconds: get('SPOOL_WAIT_SECONDS', '75'),
  }
}

const C = loadConfig()
const isWin = process.platform === 'win32'

function log(...a) { console.log(new Date().toISOString(), ...a) }

function execP(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message} ${stderr || ''}`.trim()))
      resolve(stdout)
    })
  })
}

/** Print a PDF file to the configured printer on this OS. */
async function printPdf(pdfPath) {
  if (isWin) {
    if (!existsSync(C.sumatra)) throw new Error(`SumatraPDF not found at ${C.sumatra}. Install it (free) or set SUMATRA_PATH.`)
    // Silent, no UI. -print-to selects the dedicated Brother. `noscale` forces ACTUAL SIZE (100%) —
    // never Fit/Shrink — so the check geometry prints at true inches on the check stock.
    await execP(C.sumatra, ['-print-to', C.printer, '-print-settings', 'noscale', '-silent', '-exit-when-done', pdfPath])
  } else {
    // macOS / Linux: CUPS. lp is built in on macOS. -o fit-to-page=false / scaling=100 keep actual size.
    await execP('lp', ['-d', C.printer, '-o', 'fit-to-page=false', '-o', 'scaling=100', pdfPath])
  }
}

async function api(path, body) {
  const res = await fetch(`${C.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${C.token}` },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch { /* non-json */ }
  return { status: res.status, json }
}

/** Remove a temp dir holding a check PDF. Never throws. */
function removeDir(dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

/** Startup sweep: delete any check PDFs a previous run left behind (crash / power loss). */
function sweepTemp() {
  try {
    for (const name of readdirSync(tmpdir())) if (name.startsWith(TMP_PREFIX)) removeDir(join(tmpdir(), name))
  } catch { /* best effort */ }
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`
/** How many spooler jobs on our printer belong to this document (Windows). Throws if it cannot tell. */
async function spoolCount(docTag) {
  const out = await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-PrintJob -PrinterName ${psQuote(C.printer)} -ErrorAction Stop | Where-Object { $_.DocumentName -like ${psQuote('*' + docTag + '*')} }).Count`], 20000)
  const n = parseInt(String(out).trim(), 10)
  if (!Number.isFinite(n)) throw new Error('unreadable spooler answer')
  return n
}
async function spoolCancel(docTag) {
  await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-PrintJob -PrinterName ${psQuote(C.printer)} -ErrorAction Stop | Where-Object { $_.DocumentName -like ${psQuote('*' + docTag + '*')} } | Remove-PrintJob -ErrorAction Stop`], 20000)
}

/**
 * After the driver accepted the job, watch the Windows spooler until the printer has taken it.
 *   left the spooler             → 'submitted'
 *   still stuck after the wait   → cancel it; if the cancel is confirmed → 'failed' (it will NOT print
 *                                  later), otherwise → 'uncertain' (a person must look)
 *   spooler cannot be queried    → 'submitted' with a note (a manager confirms paper either way)
 */
async function watchSpooler(docTag) {
  if (!isWin) return { outcome: 'submitted' }
  const waitMs = Math.max(15, parseInt(C.spoolWaitSeconds, 10) || 75) * 1000
  const deadline = Date.now() + waitMs
  try {
    for (;;) {
      if ((await spoolCount(docTag)) === 0) return { outcome: 'submitted' }
      if (Date.now() >= deadline) break
      await sleep(3000)
    }
  } catch (e) {
    return { outcome: 'submitted', note: `spooler not readable (${e.message})` }
  }
  try {
    await spoolCancel(docTag)
    await sleep(2000)
    if ((await spoolCount(docTag)) === 0) return { outcome: 'failed', error: 'The printer did not take the job (offline, out of paper, or jammed?). It was cancelled and will not print later.' }
  } catch { /* fall through to uncertain */ }
  return { outcome: 'uncertain', error: 'The job is stuck in the Windows print queue and could not be cancelled. Check the printer before sending again.' }
}

/** Report a job outcome; retried, because a lost report leaves the job open for a manager to settle. */
async function report(jobId, outcome, error) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await api('/api/print-bridge/result', { jobId, outcome, success: outcome === 'submitted', error: error || undefined, bridgeId: C.bridgeId })
      if (r.status === 200) return true
      log(`report ${jobId} → HTTP ${r.status} (attempt ${attempt})`)
    } catch (e) { log(`report ${jobId} failed (attempt ${attempt}): ${e.message}`) }
    await sleep(attempt * 3000)
  }
  log(`could NOT report job ${jobId} (${outcome}) — a manager will need to settle it in the app`)
  return false
}

async function processOne() {
  const claim = await api('/api/print-bridge/claim', { bridgeId: C.bridgeId, version: BRIDGE_VERSION, platform: process.platform, printer: C.printer, startedAt: STARTED_AT })
  if (claim.status === 401) throw new Error('unauthorized — check PRINT_BRIDGE_TOKEN')
  if (claim.status === 503) { return false } // bridge not configured on server yet
  if (claim.status !== 200) throw new Error(`claim failed: HTTP ${claim.status}`)
  const job = claim.json.job
  if (!job) return false // queue empty (or the server refused the job)

  log(`claimed job ${job.id} (${job.kind})`)
  let dir = null
  try {
    if (!claim.json.pdfBase64) throw new Error('claim carried no PDF')
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const pdfPath = join(dir, `${job.id}.pdf`)
    writeFileSync(pdfPath, Buffer.from(claim.json.pdfBase64, 'base64'))
    await printPdf(pdfPath)
    const spool = await watchSpooler(job.id)
    log(`job ${job.id}: ${spool.outcome}${spool.error ? ' — ' + spool.error : ''}${spool.note ? ' (' + spool.note + ')' : ''}`)
    await report(job.id, spool.outcome, spool.error || spool.note)
  } catch (e) {
    // The print command itself failed or timed out. A timeout does not prove nothing printed.
    const timedOut = /timed? ?out|ETIMEDOUT|killed/i.test(String(e.message))
    log(`print ${timedOut ? 'UNCERTAIN' : 'FAILED'} job ${job.id}: ${e.message}`)
    await report(job.id, timedOut ? 'uncertain' : 'failed', e.message)
  } finally {
    if (dir) removeDir(dir) // never leave a check PDF on disk
  }
  return true
}

async function main() {
  if (!C.baseUrl || !C.token) {
    console.error('Missing PITTSTOP_BASE_URL or PRINT_BRIDGE_TOKEN. Set env vars or scripts/print-bridge.config.json.')
    process.exit(1)
  }
  sweepTemp()
  log(`Pitt Stop print bridge v${BRIDGE_VERSION} starting — ${C.bridgeId} → ${C.printer} (${isWin ? 'windows' : process.platform}) → ${C.baseUrl}`)
  // Forever loop; never crashes on transient errors (outage-safe).
  for (;;) {
    try {
      const didWork = await processOne()
      if (!didWork) await sleep(C.pollMs)
      else await sleep(400) // drain the queue quickly when busy
    } catch (e) {
      log(`loop error (will retry): ${e.message}`)
      await sleep(Math.max(C.pollMs, 5000))
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
main()

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
 *   - Survives internet/printer outages: it just keeps looping; queued jobs wait server-side and print
 *     when the bridge/printer is back. A print failure is reported so the manager can safely resend.
 *   - No business logic, no arbitrary commands — it prints bytes and reports status.
 *
 * Config (env OR a print-bridge.config.json next to this script; env wins):
 *   PITTSTOP_BASE_URL   e.g. https://your-pitt-stop-os.vercel.app   (required)
 *   PRINT_BRIDGE_TOKEN  the shared bridge secret                     (required, matches server env)
 *   PRINTER_NAME        CUPS/Windows printer name  (default: Brother_HL_L2420DW)
 *   BRIDGE_ID           identifier for logs        (default: hostname)
 *   POLL_SECONDS        idle poll interval         (default: 5)
 *   SUMATRA_PATH        Windows only: path to SumatraPDF.exe for silent PDF printing
 *
 * Usage:  node scripts/print-bridge.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const cfg = {}
  const file = join(HERE, 'print-bridge.config.json')
  if (existsSync(file)) { try { Object.assign(cfg, JSON.parse(readFileSync(file, 'utf8'))) } catch (e) { console.error('bad config json:', e.message) } }
  const get = (k, d) => process.env[k] ?? cfg[k] ?? d
  return {
    baseUrl: (get('PITTSTOP_BASE_URL', '') || '').replace(/\/$/, ''),
    token: get('PRINT_BRIDGE_TOKEN', ''),
    printer: get('PRINTER_NAME', 'Brother_HL_L2420DW'),
    bridgeId: get('BRIDGE_ID', hostname()),
    pollMs: Math.max(2, parseInt(get('POLL_SECONDS', '5'), 10) || 5) * 1000,
    sumatra: get('SUMATRA_PATH', 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe'),
  }
}

const C = loadConfig()
const isWin = process.platform === 'win32'

function log(...a) { console.log(new Date().toISOString(), ...a) }

function execP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message} ${stderr || ''}`.trim()))
      resolve(stdout)
    })
  })
}

/** Print a PDF file to the configured printer on this OS. */
async function printPdf(pdfPath) {
  if (isWin) {
    if (!existsSync(C.sumatra)) throw new Error(`SumatraPDF not found at ${C.sumatra}. Install it (free) or set SUMATRA_PATH.`)
    // Silent, no UI. -print-to <printer> selects the dedicated Brother.
    await execP(C.sumatra, ['-print-to', C.printer, '-silent', '-exit-when-done', pdfPath])
  } else {
    // macOS / Linux: CUPS. lp is built in on macOS.
    await execP('lp', ['-d', C.printer, pdfPath])
  }
}

async function api(path, body) {
  const res = await fetch(`${C.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${C.token}` },
    body: JSON.stringify(body || {}),
  })
  const text = await res.text()
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch { /* non-json */ }
  return { status: res.status, json }
}

async function processOne() {
  const claim = await api('/api/print-bridge/claim', { bridgeId: C.bridgeId })
  if (claim.status === 401) throw new Error('unauthorized — check PRINT_BRIDGE_TOKEN')
  if (claim.status === 503) { return false } // bridge not configured on server yet
  if (claim.status !== 200) throw new Error(`claim failed: HTTP ${claim.status}`)
  const job = claim.json.job
  if (!job) return false // queue empty

  log(`claimed job ${job.id} (${job.kind})`)
  const dir = mkdtempSync(join(tmpdir(), 'pittstop-check-'))
  const pdfPath = join(dir, `${job.id}.pdf`)
  writeFileSync(pdfPath, Buffer.from(claim.json.pdfBase64, 'base64'))

  try {
    await printPdf(pdfPath)
    await api('/api/print-bridge/result', { jobId: job.id, success: true, bridgeId: C.bridgeId })
    log(`printed job ${job.id} ✓`)
  } catch (e) {
    log(`print FAILED job ${job.id}: ${e.message}`)
    await api('/api/print-bridge/result', { jobId: job.id, success: false, error: e.message, bridgeId: C.bridgeId })
  }
  return true
}

async function main() {
  if (!C.baseUrl || !C.token) {
    console.error('Missing PITTSTOP_BASE_URL or PRINT_BRIDGE_TOKEN. Set env vars or scripts/print-bridge.config.json.')
    process.exit(1)
  }
  log(`Pitt Stop print bridge starting — ${C.bridgeId} → ${C.printer} (${isWin ? 'windows' : process.platform}) → ${C.baseUrl}`)
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

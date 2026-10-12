#!/usr/bin/env node
/**
 * Builds the one-file Windows update for the shop-laptop print bridge.
 *
 *   node scripts/build-bridge-update.mjs [output.cmd]     (default: ./PittStop-Bridge-Update-R2.cmd)
 *
 * The output is a double-clickable .cmd: a three-line batch header that hands the rest of the file to
 * Windows PowerShell, followed by scripts/windows/bridge-update.ps1 with scripts/print-bridge.mjs embedded
 * (base64 + SHA-256, verified on the laptop before anything is touched). It carries no token, no config
 * and no bank data — the laptop's existing print-bridge.config.json is used as is.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = '#__PSB_BEGIN__'
// `--tempcheck <out.cmd>` builds the read-only temporary-PDF inspection instead (no embedded bridge).
const TEMPCHECK = process.argv[2] === '--tempcheck'
const out = resolve(process.argv[TEMPCHECK ? 3 : 2] || (TEMPCHECK ? 'PittStop-Bridge-TempCheck.cmd' : 'PittStop-Bridge-Update-R2.cmd'))

const bridge = readFileSync(join(HERE, 'print-bridge.mjs'))
const version = /const BRIDGE_VERSION = '([^']+)'/.exec(bridge.toString('utf8'))?.[1]
if (!version) throw new Error('BRIDGE_VERSION not found in print-bridge.mjs')
const sha256 = createHash('sha256').update(bridge).digest('hex')
const b64 = bridge.toString('base64').replace(/(.{76})/g, '$1\n')

const template = readFileSync(join(HERE, 'windows', TEMPCHECK ? 'bridge-tempcheck.ps1' : 'bridge-update.ps1'), 'utf8')
if (!template.startsWith(MARKER)) throw new Error(`bridge-update.ps1 must start with ${MARKER}`)
const ps = template
  .replace('__BRIDGE_VERSION__', version)
  .replace('__PAYLOAD_SHA256__', sha256)
  .replace('__PAYLOAD_B64__', () => b64.trimEnd())

// The marker is spelled in two halves here so the header's own text can never be mistaken for it.
const header = [
  '@echo off',
  'setlocal',
  TEMPCHECK ? 'title Pitt Stop temporary check PDF inspection' : 'title Pitt Stop print bridge update',
  'set "PSB_SELF=%~f0"',
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:PSB_SELF); $i=$t.IndexOf('#__PSB_'+'BEGIN__'); if($i -lt 0){Write-Host 'This update file is damaged.'; exit 9}; & ([scriptblock]::Create($t.Substring($i)))"`,
  'set "PSB_RC=%ERRORLEVEL%"',
  'if "%PSB_RC%"=="77" exit /b 0',
  'echo.',
  'echo You can close this window.',
  'pause >nul',
  'exit /b %PSB_RC%',
  '',
].join('\n')

const text = (header + ps).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
const bad = /[^\x09\x0A\x0D\x20-\x7E]/.exec(text)
if (bad) throw new Error(`non-ASCII character at offset ${bad.index} — the .cmd must be plain ASCII`)
if (text.indexOf(MARKER) !== text.lastIndexOf(MARKER)) throw new Error('marker appears more than once')

writeFileSync(out, text, 'latin1')
if (!TEMPCHECK) console.log(`bridge v${version}  sha256 ${sha256}`)
console.log(`wrote ${out} (${text.length} bytes)`)

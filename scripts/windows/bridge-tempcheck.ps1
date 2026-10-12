#__PSB_BEGIN__
# Pitt Stop print bridge - temporary check PDF inspection (Windows shop laptop). READ-ONLY.
# Counts leftover `pittstop-check-*` folders in every temp directory and reports the bridge version from
# its own log. Changes nothing, deletes nothing, opens no PDF, reads no config. ASCII; PowerShell 5.1.
# Built into a double-clickable .cmd by `node scripts/build-bridge-update.mjs --tempcheck <out.cmd>`.
$ErrorActionPreference = 'Stop'
$Self = $env:PSB_SELF
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Asking Windows for permission (needed to look in every temp folder) - choose YES...' -ForegroundColor Cyan
  try { Start-Process -FilePath $env:ComSpec -ArgumentList ('/c ""' + $Self + '""') -Verb RunAs; exit 77 }
  catch { Write-Host 'RESULT: NOT CHECKED - Windows permission was not given.' -ForegroundColor Red; exit 2 }
}
$roots = @($env:TEMP, [IO.Path]::GetTempPath(), (Join-Path $env:SystemRoot 'Temp'),
  (Join-Path $env:SystemRoot 'System32\config\systemprofile\AppData\Local\Temp'),
  (Join-Path $env:SystemRoot 'SysWOW64\config\systemprofile\AppData\Local\Temp'))
$usersDir = Split-Path -Parent $env:PUBLIC
if ($usersDir -and (Test-Path -LiteralPath $usersDir)) {
  foreach ($u in @(Get-ChildItem -LiteralPath $usersDir -Directory -Force -ErrorAction SilentlyContinue)) { $roots += (Join-Path $u.FullName 'AppData\Local\Temp') }
}
$seen = @{}; $looked = 0; $folders = 0; $files = 0; $unreadable = 0
Write-Host ''
Write-Host 'Pitt Stop - temporary check PDF inspection (read-only)' -ForegroundColor Cyan
foreach ($r in $roots) {
  if (-not $r) { continue }
  $full = $r.TrimEnd('\')
  if ($seen.ContainsKey($full.ToLowerInvariant())) { continue }
  $seen[$full.ToLowerInvariant()] = $true
  if (-not (Test-Path -LiteralPath $full)) { continue }
  try {
    $found = @(Get-ChildItem -LiteralPath $full -Directory -Force -Filter 'pittstop-check-*' -ErrorAction Stop)
    $looked++
    $n = 0
    foreach ($d in $found) { $n += @(Get-ChildItem -LiteralPath $d.FullName -File -Force -ErrorAction SilentlyContinue).Count }
    $folders += @($found).Count; $files += $n
    Write-Host ('  ' + $full + ' : ' + @($found).Count + ' folder(s), ' + $n + ' file(s)')
  } catch { $unreadable++; Write-Host ('  ' + $full + ' : could not be read') -ForegroundColor Yellow }
}
$version = 'unknown'
try {
  $log = 'C:\pittstop\bridge.log'
  if ([IO.File]::Exists($log)) {
    $fs = New-Object IO.FileStream($log, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $want = [int][Math]::Min(65536, $fs.Length); [void]$fs.Seek(-$want, [IO.SeekOrigin]::End)
      $buf = New-Object byte[] $want; $got = $fs.Read($buf, 0, $want)
      $m = [regex]::Matches([Text.Encoding]::UTF8.GetString($buf, 0, $got), 'print bridge v([0-9.]+) starting')
      if ($m.Count -gt 0) { $version = $m[$m.Count - 1].Groups[1].Value }
    } finally { $fs.Close() }
  }
} catch { }
Write-Host ''
$color = 'Green'; $word = 'CLEAN'
if ($folders -gt 0) { $color = 'Red'; $word = 'LEFTOVERS FOUND' }
elseif ($looked -eq 0 -or $unreadable -gt 0) { $color = 'Yellow'; $word = 'INCOMPLETE' }
Write-Host '============================================================' -ForegroundColor $color
Write-Host ('RESULT: ' + $word + ' - ' + $folders + ' leftover check folder(s), ' + $files + ' file(s); looked in ' + $looked + ' temp folder(s), ' + $unreadable + ' unreadable; bridge v' + $version) -ForegroundColor $color
Write-Host '============================================================' -ForegroundColor $color
exit 0

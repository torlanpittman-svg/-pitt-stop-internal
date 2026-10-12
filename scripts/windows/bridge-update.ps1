#__PSB_BEGIN__
# Pitt Stop print bridge updater (Windows shop laptop). ASCII only; Windows PowerShell 5.1 compatible.
#
# This is the TEMPLATE. `node scripts/build-bridge-update.mjs` embeds scripts/print-bridge.mjs into it and
# wraps it in a double-clickable .cmd. Do not run this file directly.
#
# How the bridge runs on the laptop (this is what the updater has to respect):
#   scheduled task  ->  wscript start-bridge.vbs  ->  hidden `cmd /c start-bridge.bat` (the SUPERVISOR: an
#   endless loop)   ->  `node print-bridge.mjs` (relative path), relaunched 5 seconds after it exits.
#   So killing node alone only makes the supervisor start another one, and starting the task while a
#   supervisor is alive makes a second bridge. Both are stopped together and exactly one is started.
#
# What it does, in order:
#   1. PREFLIGHT, changing nothing: finds the bridge, its auto-start task and config; checks the printer
#      name, SumatraPDF, Node, an idle print queue, and that the new script is intact and parses.
#   2. Stops the supervisor(s) and bridge process(es) and waits until none comes back.
#   3. Backs up the installed script (an existing backup is never overwritten), replaces ONLY
#      print-bridge.mjs, deletes leftover temporary check PDFs.
#   4. Starts the bridge through its own auto-start task and requires: exactly one bridge process, the
#      same process still alive later (no crash loop), and the bridge's own log showing the new version
#      and that the server accepted its token.
#   5. On a genuine failure, puts the previous script back and restarts it, checked the same way.
#
# What it never does: show, change or create the token/config; change the auto-start task, its scripts,
# the printer, the server URL or any print setting; print anything; call the Pitt Stop server or
# QuickBooks itself; change any Windows policy. Safe to run more than once; refuses to run twice at once.
#
# PowerShell 5.1 rule used throughout: never read .Count from a command's result directly - wrap it in
# @( ). A single CIM process object has no usable .Count there, so "one bridge running" read as "none".

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$UpdaterRev      = 'R2'
$ExpectedPrinter = 'Brother HL-L2420DW Printer'
$ExpectedHost    = 'pitt-stop-internal.vercel.app'
$DefaultDir      = 'C:\pittstop'
$DefaultSumatra  = 'C:\Program Files\SumatraPDF\SumatraPDF.exe'
$ScriptName      = 'print-bridge.mjs'
$ConfigName      = 'print-bridge.config.json'
$SuperBat        = 'start-bridge.bat'
$SuperVbs        = 'start-bridge.vbs'
$TempPrefix      = 'pittstop-check-'
$NewVersion      = '__BRIDGE_VERSION__'
$PayloadSha256   = '__PAYLOAD_SHA256__'
$PayloadB64 = @'
__PAYLOAD_B64__
'@

$Self = $env:PSB_SELF
$script:LogFile = $null
$script:Warnings = 0
$script:Secret = $null
$script:Dir = $null
$script:Task = $null
$script:BridgeLog = $null
$script:Phase = 'checking'

# ---------------------------------------------------------------------------------------------------
# Output. Everything shown or logged passes through Redact, so the token can never be written out.
# ---------------------------------------------------------------------------------------------------
function Redact([string]$text) {
  if ($script:Secret -and $text) { return $text.Replace($script:Secret, '[token hidden]') }
  return $text
}
function Log([string]$msg) {
  if (-not $script:LogFile) { return }
  try { Add-Content -LiteralPath $script:LogFile -Value ((Get-Date).ToString('s') + '  ' + (Redact $msg)) -Encoding ASCII } catch { }
}
function Say([string]$msg, [string]$color = 'Gray') { Write-Host (Redact $msg) -ForegroundColor $color; Log $msg }
function Ok([string]$msg)   { Say ('  [ok]   ' + $msg) 'Green' }
function Warn([string]$msg) { $script:Warnings++; Say ('  [warn] ' + $msg) 'Yellow' }
function Finish([string]$result, [string]$detail, [string]$color, [int]$code) {
  if ($code -ne 0) { try { Diagnostics 'final state' } catch { } }
  Say ''
  Say '============================================================' $color
  Say ('RESULT: ' + $result) $color
  if ($detail) { Say $detail $color }
  Say '============================================================' $color
  if ($script:LogFile) {
    Write-Host ('(details saved in ' + $script:LogFile + ')') -ForegroundColor DarkGray
    if ($code -ne 0 -and $Self) {
      # A copy next to the update file, so it is easy to find. Contains no token and no config contents.
      try {
        $copy = Join-Path (Split-Path -Parent $Self) 'PittStop-Bridge-Diagnostics.txt'
        Copy-Item -LiteralPath $script:LogFile -Destination $copy -Force
        Write-Host ('(a copy for Claude is at ' + $copy + ')') -ForegroundColor DarkGray
      } catch { }
    }
  }
  exit $code
}
function Abort([string]$why) { Finish 'NOT UPDATED - nothing was changed' ('Reason: ' + $why) 'Red' 2 }

function Sha256Of([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

# ---------------------------------------------------------------------------------------------------
# Finding Pitt Stop's own processes - and nothing else.
# ---------------------------------------------------------------------------------------------------
# True when $commandLine names $file as a file of THIS install: either by bare/relative name (the real
# launch is `node print-bridge.mjs` from inside the folder) or by a full path that is this folder.
# A full path into any other folder is somebody else's file and is never matched.
function NamesOurFile([string]$commandLine, [string]$file) {
  if (-not $commandLine) { return $false }
  $start = 0
  for (;;) {
    $i = $commandLine.IndexOf($file, $start, [StringComparison]::OrdinalIgnoreCase)
    if ($i -lt 0) { return $false }
    $start = $i + 1
    $end = $i + $file.Length
    if ($end -lt $commandLine.Length -and (' "' + "`t").IndexOf($commandLine[$end]) -lt 0) { continue }   # longer name
    if ($i -eq 0) { return $true }
    $before = $commandLine.Substring(0, $i)
    $prev = $before[$before.Length - 1]
    if ($prev -eq ' ' -or $prev -eq '"' -or $prev -eq "`t") { return $true }                             # bare name
    if ($prev -ne '\' -and $prev -ne '/') { continue }                                                    # part of another name
    $norm = $before.Replace('/', '\')
    if ($norm.EndsWith(' .\') -or $norm.EndsWith('".\') -or $norm -eq '.\') { return $true }              # .\name
    $ourDir = ('' + $script:Dir).Replace('/', '\')
    if ($ourDir -and $norm.EndsWith($ourDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
      $j = $norm.Length - ($ourDir.Length + 1)
      if ($j -eq 0 -or $norm[$j - 1] -eq ' ' -or $norm[$j - 1] -eq '"') { return $true }                  # our folder
    }
  }
}

# One consistent picture of what is running: bridge node process(es), supervisor cmd loop(s), launcher(s).
# The updater's own process and its parents are always excluded.
function Snapshot {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byId = @{}
  foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  $mine = @{}
  $mine[[int]$PID] = $true
  $cur = [int]$PID
  for ($g = 0; $g -lt 32 -and $byId.ContainsKey($cur); $g++) { $mine[$cur] = $true; $cur = [int]$byId[$cur].ParentProcessId }

  $nodes = @(); $supers = @(); $launchers = @(); $superIds = @{}
  foreach ($p in $all) {
    $id = [int]$p.ProcessId
    if ($mine.ContainsKey($id)) { continue }
    $cl = '' + $p.CommandLine
    $name = ('' + $p.Name).ToLowerInvariant()
    if ($name -eq 'node.exe' -and (NamesOurFile $cl $ScriptName)) { $nodes += $p }
    elseif ($name -eq 'cmd.exe' -and (NamesOurFile $cl $SuperBat)) { $supers += $p; $superIds[$id] = $true }
    elseif (($name -eq 'wscript.exe' -or $name -eq 'cscript.exe') -and (NamesOurFile $cl $SuperVbs)) { $launchers += $p }
  }
  # A cmd.exe that is the live parent of a bridge process is its supervisor whatever its script is called.
  # (Started-before-the-child guards against a recycled process id pointing at an unrelated cmd.)
  foreach ($n in $nodes) {
    $pp = [int]$n.ParentProcessId
    if ($superIds.ContainsKey($pp) -or $mine.ContainsKey($pp) -or -not $byId.ContainsKey($pp)) { continue }
    $par = $byId[$pp]
    if (('' + $par.Name).ToLowerInvariant() -ne 'cmd.exe') { continue }
    if ($par.CreationDate -and $n.CreationDate -and $par.CreationDate -gt $n.CreationDate) { continue }
    $supers += $par; $superIds[$pp] = $true
  }
  return @{ Nodes = $nodes; Supers = $supers; Launchers = $launchers }
}
function NodeCount($s)  { @($s.Nodes).Count }
function SuperCount($s) { @($s.Supers).Count }
function LiveCount($s)  { @($s.Nodes).Count + @($s.Supers).Count + @($s.Launchers).Count }
function Describe($p) {
  $made = ''
  try { if ($p.CreationDate) { $made = ([datetime]$p.CreationDate).ToString('s') } } catch { }
  ('' + $p.Name + ' pid=' + $p.ProcessId + ' parent=' + $p.ParentProcessId + ' started=' + $made + ' cmd=' + $p.CommandLine)
}
function LogSnapshot([string]$label, $s) {
  Log ('processes [' + $label + ']: ' + (NodeCount $s) + ' bridge, ' + (SuperCount $s) + ' supervisor, ' + @($s.Launchers).Count + ' launcher')
  foreach ($p in (@($s.Launchers) + @($s.Supers) + @($s.Nodes))) { Log ('    ' + (Describe $p)) }
}

# Stop every supervisor and bridge of this install and prove none comes back. Supervisors go first so
# they cannot relaunch the bridge; the quiet period is longer than the supervisor's 5-second restart delay.
function StopAll([string]$label) {
  for ($round = 1; $round -le 4; $round++) {
    if ($script:Task) { try { Stop-ScheduledTask -TaskName $script:Task.TaskName -TaskPath $script:Task.TaskPath -ErrorAction SilentlyContinue } catch { } }
    for ($i = 0; $i -lt 30; $i++) {
      $s = Snapshot
      $targets = @($s.Launchers) + @($s.Supers) + @($s.Nodes)
      if (@($targets).Count -eq 0) { break }
      foreach ($p in $targets) {
        Log ('stopping (' + $label + ', round ' + $round + '): ' + (Describe $p))
        try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue } catch { }
      }
      Start-Sleep -Milliseconds 500
    }
    $quiet = $true
    for ($i = 0; $i -lt 8; $i++) {
      Start-Sleep -Seconds 1
      $s = Snapshot
      if ((LiveCount $s) -gt 0) { $quiet = $false; LogSnapshot ('came back during quiet period, round ' + $round) $s; break }
    }
    if ($quiet) { Log ('all stopped and stayed stopped (' + $label + ', round ' + $round + ')'); return $true }
  }
  return $false
}

# The bridge's own log (the supervisor redirects node's output there). Read from a remembered offset so
# only lines written by the process we just started are considered.
function LogLength { try { if ([IO.File]::Exists($script:BridgeLog)) { return (New-Object IO.FileInfo($script:BridgeLog)).Length } } catch { }; return 0 }
function ReadLogFrom([long]$offset) {
  try {
    if (-not [IO.File]::Exists($script:BridgeLog)) { return '' }
    $fs = New-Object IO.FileStream($script:BridgeLog, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      if ($fs.Length -lt $offset) { $offset = 0 }
      $want = [int][Math]::Min(262144, $fs.Length - $offset)
      if ($want -le 0) { return '' }
      [void]$fs.Seek($offset, [IO.SeekOrigin]::Begin)
      $buf = New-Object byte[] $want
      $n = $fs.Read($buf, 0, $want)
      return [Text.Encoding]::UTF8.GetString($buf, 0, $n)
    } finally { $fs.Close() }
  } catch { return '' }
}

# Start the bridge through its EXISTING auto-start task (exactly as after a reboot) and verify it.
# $expectVersion: the version the bridge must announce in its log, or $null for the previous script
# (which announces nothing) - then only the process checks apply.
# Returns @{ Ok; Why; Started; Connected; NewLog }.
function StartAndVerify([string]$expectVersion, [string]$label) {
  $r = @{ Ok = $false; Why = ''; Started = $false; Connected = $false; NewLog = '' }
  $pre = Snapshot
  if ((LiveCount $pre) -gt 0) { $r.Why = 'a bridge or supervisor was already running before the start'; LogSnapshot ($label + ': unexpected before start') $pre; return $r }
  $offset = LogLength
  try { Start-ScheduledTask -TaskName $script:Task.TaskName -TaskPath $script:Task.TaskPath }
  catch { $r.Why = 'Windows could not start the auto-start task (' + $_.Exception.Message + ')'; return $r }

  $first = $null
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    $s = Snapshot
    if ((NodeCount $s) -ge 1) { $first = @($s.Nodes)[0]; break }
  }
  if (-not $first) { $r.Why = 'no bridge process appeared within 45 seconds'; LogSnapshot ($label + ': nothing appeared') (Snapshot); return $r }
  $firstId = [int]$first.ProcessId
  Log ($label + ': bridge process appeared: ' + (Describe $first))
  # Recorded for the write-up of the earlier failed attempts: on Windows PowerShell 5.1 this is expected to be empty.
  $probe = $first.Count
  if ($null -eq $probe) { Log 'diagnostic: one process object .Count = <null>' } else { Log ('diagnostic: one process object .Count = ' + $probe) }

  # Still the SAME process 15 seconds later? Under a supervisor a crashing bridge is relaunched every few
  # seconds, so "a bridge process exists" proves nothing - the process id has to hold.
  for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 1 }
  $connectedRx = 'connected .{1,6}server accepted'
  $startedRx = $null
  if ($expectVersion) { $startedRx = 'print bridge v' + [regex]::Escape($expectVersion) + ' starting' }
  for ($i = 0; $i -lt 46; $i++) {
    $s = Snapshot
    if ($i -eq 0) { LogSnapshot ($label + ': verify') $s }
    $n = NodeCount $s
    if ($n -eq 0) { $r.Why = 'the bridge process stopped' }
    elseif ($n -gt 1 -or (SuperCount $s) -gt 1) { $r.Why = 'more than one bridge or supervisor is running' }
    elseif ([int](@($s.Nodes)[0]).ProcessId -ne $firstId) { $r.Why = 'the bridge keeps restarting (it does not stay up)' }
    if ($r.Why) { LogSnapshot ($label + ': failed check') $s; break }
    $r.NewLog = ReadLogFrom $offset
    if (-not $expectVersion) { $r.Ok = $true; break }
    if ($r.NewLog -match 'unauthorized') { $r.Why = 'the server rejected the bridge token'; break }
    if ($r.NewLog -match 'Missing PITTSTOP_BASE_URL|bad config json') { $r.Why = 'the bridge could not read its config'; break }
    $r.Started = ($r.NewLog -match $startedRx)
    $r.Connected = ($r.NewLog -match $connectedRx)
    if ($r.Started -and $r.Connected) { $r.Ok = $true; break }
    if ($i -eq 45) { $r.Ok = $true; break }     # running and stable; the log evidence is judged by the caller
    Start-Sleep -Seconds 1
  }
  if ($r.NewLog) { Log ($label + ': bridge log since start:'); foreach ($line in @($r.NewLog -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 25)) { Log ('    | ' + $line) } }
  else { Log ($label + ': the bridge wrote nothing to ' + $script:BridgeLog) }
  Log ($label + ': ok=' + $r.Ok + ' started=' + $r.Started + ' connected=' + $r.Connected + ' why=' + $r.Why)
  return $r
}

function ActionText($task) {
  $parts = @()
  foreach ($a in @($task.Actions)) { $parts += ('' + $a.Execute + ' ' + $a.Arguments + ' ' + $a.WorkingDirectory) }
  ($parts -join ' ')
}
function BridgeTasks {
  @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    ($_.TaskPath -notlike '\Microsoft\*') -and ((ActionText $_) -match 'print-bridge|start-bridge|pittstop')
  })
}

function TempRoots {
  $roots = @($env:TEMP, [IO.Path]::GetTempPath(), (Join-Path $env:SystemRoot 'Temp'),
    (Join-Path $env:SystemRoot 'System32\config\systemprofile\AppData\Local\Temp'),
    (Join-Path $env:SystemRoot 'SysWOW64\config\systemprofile\AppData\Local\Temp'))
  $usersDir = Split-Path -Parent $env:PUBLIC
  if ($usersDir -and (Test-Path -LiteralPath $usersDir)) {
    foreach ($u in @(Get-ChildItem -LiteralPath $usersDir -Directory -Force -ErrorAction SilentlyContinue)) {
      $roots += (Join-Path $u.FullName 'AppData\Local\Temp')
    }
  }
  $seen = @{}
  foreach ($r in $roots) {
    if (-not $r) { continue }
    $full = $r.TrimEnd('\')
    if ($seen.ContainsKey($full.ToLowerInvariant())) { continue }
    $seen[$full.ToLowerInvariant()] = $true
    if (Test-Path -LiteralPath $full) { $full }
  }
}
function LeftoverDirs {
  $found = @()
  foreach ($r in @(TempRoots)) {
    $found += @(Get-ChildItem -LiteralPath $r -Directory -Force -Filter ($TempPrefix + '*') -ErrorAction SilentlyContinue)
  }
  $found
}

# Facts for troubleshooting, written to the log only. No token, no config contents.
function Diagnostics([string]$label) {
  if (-not $script:LogFile) { return }
  Log ('---- diagnostics: ' + $label + ' ----')
  try { Log ('powershell ' + $PSVersionTable.PSVersion.ToString() + ' on ' + [Environment]::OSVersion.VersionString + ', user ' + [Environment]::UserName) } catch { }
  try { LogSnapshot $label (Snapshot) } catch { Log ('snapshot failed: ' + $_.Exception.Message) }
  try {
    foreach ($t in @(BridgeTasks)) {
      Log ('task "' + $t.TaskPath + $t.TaskName + '" state=' + $t.State + ' action=' + (ActionText $t))
      Log ('    runs as=' + $t.Principal.UserId + ' logon=' + $t.Principal.LogonType + ' level=' + $t.Principal.RunLevel +
           ' timeLimit=' + $t.Settings.ExecutionTimeLimit + ' multipleInstances=' + $t.Settings.MultipleInstances)
    }
  } catch { Log ('task details failed: ' + $_.Exception.Message) }
  try {
    if ($script:Dir) {
      foreach ($f in @(Get-ChildItem -LiteralPath $script:Dir -File -Force -ErrorAction SilentlyContinue)) {
        $line = '    file ' + $f.Name + ' size=' + $f.Length + ' modified=' + $f.LastWriteTime.ToString('s')
        if ($f.Extension -match '^\.(mjs|bat|vbs|cmd)$') { $line += ' sha256=' + (Sha256Of $f.FullName).Substring(0, 12) }
        Log $line
      }
    }
  } catch { Log ('file list failed: ' + $_.Exception.Message) }
}

# Anything unexpected still ends in a clear RESULT line, and never leaves the laptop with no bridge.
trap {
  $err = '' + $_
  try { Log ('UNEXPECTED ERROR while ' + $script:Phase + ': ' + $err + ' @ ' + $_.ScriptStackTrace) } catch { }
  try { if ($script:Dir) { Remove-Item -LiteralPath (Join-Path $script:Dir 'print-bridge.next.mjs') -Force -ErrorAction SilentlyContinue } } catch { }
  if ($script:Phase -eq 'checking') {
    Finish 'NOT UPDATED - nothing was changed' ('Reason: the updater hit an unexpected error while checking (' + $err + '). Tell Claude.') 'Red' 2
  }
  $live = -1
  try { $live = LiveCount (Snapshot) } catch { }
  if ($live -eq 0 -and $script:Task) { try { Start-ScheduledTask -TaskName $script:Task.TaskName -TaskPath $script:Task.TaskPath } catch { } }
  Finish 'UPDATE STOPPED BY AN ERROR' ('The updater hit an unexpected error while ' + $script:Phase + ' (' + $err + '). Restart the laptop, then tell Claude.') 'Red' 7
}

# ---------------------------------------------------------------------------------------------------
# 0. Administrator rights, and only one updater at a time
# ---------------------------------------------------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Asking Windows for permission - choose YES on the next prompt...' -ForegroundColor Cyan
  try {
    Start-Process -FilePath $env:ComSpec -ArgumentList ('/c ""' + $Self + '""') -Verb RunAs
    exit 77
  } catch {
    Finish 'NOT UPDATED - nothing was changed' 'Reason: Windows permission was not given. Run it again and choose YES.' 'Red' 2
  }
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\PittStopBridgeUpdate')
$haveLock = $false
try { $haveLock = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $haveLock = $true }
if (-not $haveLock) {
  Finish 'NOT UPDATED - nothing was changed' 'Reason: another copy of this update is already running. Wait for it to finish; do not run it twice at once.' 'Red' 2
}

Write-Host ''
Write-Host ('Pitt Stop print bridge update ' + $UpdaterRev + '  ->  bridge v' + $NewVersion) -ForegroundColor Cyan
Write-Host 'Checking this laptop first. Nothing is changed until every check passes.' -ForegroundColor Cyan
Write-Host 'This takes one to three minutes. Do not send anything to the printer meanwhile.' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------------------------------------------
# 1. PREFLIGHT - read-only
# ---------------------------------------------------------------------------------------------------
$tasks = BridgeTasks

# Where is the bridge installed? From what is scheduled and running, then the default folder.
$candidates = @()
$pathRx = '[A-Za-z]:\\[^"<>|?*]*?\\(?:print-bridge\.mjs|start-bridge\.(?:vbs|bat))'
$texts = @()
foreach ($t in $tasks) {
  $texts += (ActionText $t)
  foreach ($a in @($t.Actions)) { if ($a.WorkingDirectory) { $candidates += ('' + $a.WorkingDirectory).Trim('"') } }
}
foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
  if (('' + $p.CommandLine) -match 'print-bridge|start-bridge') { $texts += ('' + $p.CommandLine) }
}
foreach ($text in $texts) { foreach ($m in [regex]::Matches($text, $pathRx)) { $candidates += (Split-Path -Parent $m.Value) } }
$candidates += $DefaultDir
foreach ($c in $candidates) {
  if (-not $c) { continue }
  $has = $false
  try { $has = ([IO.File]::Exists([IO.Path]::Combine($c, $ScriptName)) -and [IO.File]::Exists([IO.Path]::Combine($c, $ConfigName))) } catch { }
  if ($has) { $script:Dir = $c.TrimEnd('\'); break }
}
if (-not $script:Dir) { Abort ('The print bridge was not found on this computer (looked for ' + $DefaultDir + '\' + $ScriptName + ' and its config). Is this the shop laptop?') }
$Dir = $script:Dir

$Target = Join-Path $Dir $ScriptName
$Config = Join-Path $Dir $ConfigName
$Staged = Join-Path $Dir 'print-bridge.next.mjs'
$script:BridgeLog = Join-Path $Dir 'bridge.log'
$script:LogFile = Join-Path $Dir 'bridge-update.log'

# Config: read only to check it. The token is kept in memory solely so Redact can blank it.
$cfg = $null
try { $cfg = ([IO.File]::ReadAllText($Config)).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { Abort 'The bridge config file could not be read. It was left untouched.' }
function Effective([string]$name) {
  foreach ($scope in @('Machine', 'User')) {
    $v = [Environment]::GetEnvironmentVariable($name, $scope)
    if ($v) { return $v }
  }
  $prop = $cfg.PSObject.Properties[$name]
  if ($prop -and $prop.Value) { return ('' + $prop.Value) }
  return $null
}
$script:Secret = Effective 'PRINT_BRIDGE_TOKEN'
if (-not $script:Secret) { Abort 'The bridge config has no token. It was left untouched.' }

Say ('--- update ' + $UpdaterRev + ' (bridge v' + $NewVersion + ') run on ' + $env:COMPUTERNAME + ' ---')
Diagnostics 'before'
Ok ('Bridge found in ' + $Dir)
Ok 'Bridge token is present (kept as is, not shown)'

$baseUrl = Effective 'PITTSTOP_BASE_URL'
$urlHost = $null
try { $urlHost = ([Uri]$baseUrl).Host } catch { }
if (-not $urlHost) { Abort 'The bridge config has no server address. It was left untouched.' }
if ($urlHost -eq $ExpectedHost) { Ok ('Server address is production (' + $urlHost + ')') }
else { Warn ('Server address is ' + $urlHost + ' (expected ' + $ExpectedHost + '). Left as is.') }

$printer = Effective 'PRINTER_NAME'
if ($printer -ne $ExpectedPrinter) { Abort ('The bridge is set to printer "' + $printer + '", not "' + $ExpectedPrinter + '".') }
$printerObj = $null
try { $printerObj = Get-Printer -Name $ExpectedPrinter -ErrorAction Stop } catch { }
if (-not $printerObj) { Abort ('Windows has no printer named "' + $ExpectedPrinter + '".') }
Ok ('Printer is "' + $ExpectedPrinter + '"')

$sumatra = Effective 'SUMATRA_PATH'
if (-not $sumatra) { $sumatra = $DefaultSumatra }
if (-not (Test-Path -LiteralPath $sumatra)) { Abort ('SumatraPDF was not found at ' + $sumatra + '.') }
Ok 'SumatraPDF is installed (actual-size "noscale" printing is built into the bridge)'

# The print queue must be idle: the bridge is never restarted in the middle of a print.
$queueReadable = $true
$waiting = 0
try { $waiting = @(Get-PrintJob -PrinterName $ExpectedPrinter -ErrorAction Stop).Count } catch { $queueReadable = $false }
if ($queueReadable -and $waiting -gt 0) { Abort ('The printer has ' + $waiting + ' job(s) waiting. Let it finish or clear the queue, then run this again.') }
if ($queueReadable) { Ok 'Windows print queue is readable and empty' }
else { Warn 'Windows print queue could not be read. The new bridge will still print, but cannot watch the queue.' }

# Auto-start task: used as is to start the bridge. Never modified.
$enabled = @($tasks | Where-Object { $_.State -ne 'Disabled' })
if (@($enabled).Count -eq 0) { Abort 'The bridge auto-start task was not found, so the bridge could not be restarted safely.' }
$script:Task = $enabled[0]
if (@($enabled).Count -gt 1) { Abort ('More than one bridge auto-start task exists (' + @($enabled).Count + '). Starting through one of them could run two bridges.') }
Ok ('Auto-start task "' + $script:Task.TaskName + '" found (kept as is)')

$before = Snapshot
$wasRunning = ((NodeCount $before) -gt 0)
if ((NodeCount $before) -eq 1 -and (SuperCount $before) -le 1) { Ok 'One bridge is currently running' }
elseif (-not $wasRunning) { Warn 'The bridge was not running before the update.' }
else { Warn ('Found ' + (NodeCount $before) + ' bridge processes and ' + (SuperCount $before) + ' supervisors (left over from earlier attempts). They will be replaced by exactly one.') }

# Node: the one the bridge actually uses.
$node = $null
foreach ($p in @($before.Nodes)) { if ($p.ExecutablePath -and (Test-Path -LiteralPath $p.ExecutablePath)) { $node = $p.ExecutablePath; break } }
if (-not $node) { $cmd = Get-Command node.exe -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }
if (-not $node) { Abort 'Node.js was not found.' }
$nodeVer = ('' + (& $node --version)).Trim()
$major = 0
[void][int]::TryParse(($nodeVer -replace '^v', '').Split('.')[0], [ref]$major)
if ($major -lt 18) { Abort ('Node.js ' + $nodeVer + ' is too old for the new bridge (needs 18 or newer).') }
Ok ('Node.js ' + $nodeVer)

# The new script: intact (matches the fingerprint it was built with) and parses on this Node.
$bytes = [Convert]::FromBase64String(($PayloadB64 -replace '\s', ''))
$sha = [Security.Cryptography.SHA256]::Create()
$gotHash = (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
if ($gotHash -ne $PayloadSha256) { Abort 'This update file is damaged (fingerprint mismatch). Download it again.' }
$checkOk = $false
try {
  [IO.File]::WriteAllBytes($Staged, $bytes)
  & $node --check $Staged 2>$null | Out-Null
  $checkOk = ($LASTEXITCODE -eq 0)
} catch { $checkOk = $false }
if (-not $checkOk) {
  Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
  Abort 'The new bridge script did not pass the Node.js check on this laptop.'
}
Ok ('New bridge v' + $NewVersion + ' is intact and passes the Node.js check')

$oldHash = Sha256Of $Target
$alreadyCurrent = ($oldHash -eq $PayloadSha256)
Log ('installed script sha256=' + $oldHash + ' ; new sha256=' + $PayloadSha256 + ' ; alreadyCurrent=' + $alreadyCurrent)

# The original backup is made BEFORE anything is stopped, and an existing backup is never overwritten.
$Backup = $null
if (-not $alreadyCurrent) {
  $Backup = Join-Path $Dir ('print-bridge.backup-' + $oldHash.Substring(0, 8) + '.mjs')
  if (-not (Test-Path -LiteralPath $Backup)) { Copy-Item -LiteralPath $Target -Destination $Backup }
  if ((Sha256Of $Backup) -ne $oldHash) { Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue; Abort 'Could not make a backup of the current bridge script.' }
  Ok ('Current bridge script is backed up as ' + (Split-Path -Leaf $Backup))
}

# ---------------------------------------------------------------------------------------------------
# 2. STOP supervisor(s) and bridge(s)
# ---------------------------------------------------------------------------------------------------
Say ''
Say 'All checks passed. Stopping the bridge (about 10 seconds)...' 'Cyan'
$script:Phase = 'stopping the bridge'
if (-not (StopAll 'before update')) {
  Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
  $now = Snapshot
  LogSnapshot 'could not stop' $now
  if ((LiveCount $now) -eq 0) { try { Start-ScheduledTask -TaskName $script:Task.TaskName -TaskPath $script:Task.TaskPath } catch { } }
  Finish 'NOT UPDATED - previous version kept' 'Reason: the running bridge could not be stopped cleanly, so nothing was replaced. Restart the laptop, then tell Claude.' 'Red' 3
}
Ok 'Bridge and its supervisor are stopped'

# ---------------------------------------------------------------------------------------------------
# 3. REPLACE the script, sweep leftover PDFs
# ---------------------------------------------------------------------------------------------------
$script:Phase = 'installing the new script'
if ($alreadyCurrent) {
  Ok ('v' + $NewVersion + ' is already installed - not replacing it again')
} else {
  $written = $false
  try { Copy-Item -LiteralPath $Staged -Destination $Target -Force; $written = ((Sha256Of $Target) -eq $PayloadSha256) } catch { $written = $false }
  if (-not $written) {
    try { Copy-Item -LiteralPath $Backup -Destination $Target -Force } catch { }
    Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
    $back = StartAndVerify $null 'restart after failed write'
    if ($back.Ok -and (Sha256Of $Target) -eq $oldHash) { Finish 'NOT UPDATED - previous version is running again' 'Reason: the new script could not be written. Tell Claude.' 'Red' 3 }
    Finish 'NOT UPDATED - and the bridge is NOT running' ('Reason: the new script could not be written, and the previous bridge did not come back (' + $back.Why + '). Restart the laptop, then tell Claude.') 'Red' 5
  }
  Ok 'New bridge script installed'
}
Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue

# Leftover temporary check PDFs (the previous bridge never deleted them). Counted, never opened.
$left = @(LeftoverDirs)
$pdfCount = 0
foreach ($d in $left) {
  $pdfCount += @(Get-ChildItem -LiteralPath $d.FullName -File -Force -ErrorAction SilentlyContinue).Count
  try { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop } catch { }
}
$remaining = @(LeftoverDirs).Count
if ($remaining -eq 0) { Ok ('Temporary check PDFs removed: ' + $pdfCount + ' file(s) in ' + @($left).Count + ' folder(s); none remain') }
else { Warn ($remaining + ' temporary check folder(s) could not be removed. The new bridge will try again when it starts.') }

# ---------------------------------------------------------------------------------------------------
# 4. START exactly one bridge and verify it
# ---------------------------------------------------------------------------------------------------
Say 'Starting the bridge through its auto-start task and checking it (up to 2 minutes)...' 'Cyan'
$script:Phase = 'starting the new bridge'
$run = StartAndVerify $NewVersion 'new bridge'
if ($run.Ok) {
  Ok 'Exactly one bridge is running and it stayed up'
  $kept = 'Token, config, auto-start, printer and print settings are unchanged.'
  if ($script:Warnings -gt 0) { $kept += "`r`n" + $script:Warnings + ' warning(s) above - tell Claude what they say.' }
  if ($run.Started -and $run.Connected) {
    Ok ('The bridge reports v' + $NewVersion + ' and the server accepted its token')
    $word = 'UPDATED OK'
    if ($alreadyCurrent) { $word = 'ALREADY UP TO DATE' }
    Finish $word ('Bridge v' + $NewVersion + ' is running and connected to Pitt Stop OS. ' + $kept) 'Green' 0
  }
  if ($run.Started) {
    Warn 'The bridge has not reached the Pitt Stop server yet. It keeps retrying by itself.'
    Finish 'UPDATED - SERVER CONNECTION NOT CONFIRMED' ('Bridge v' + $NewVersion + ' is installed and running, but it has not connected yet (is the internet up?). ' + $kept + "`r`nTell Claude.") 'Yellow' 6
  }
  Warn 'The bridge is running, but its log did not show which version started.'
  Finish 'UPDATED - VERSION NOT CONFIRMED ON THIS LAPTOP' ('Bridge v' + $NewVersion + ' is installed and one bridge is running. ' + $kept + "`r`nTell Claude, who can confirm the version from the server.") 'Yellow' 6
}

# ---------------------------------------------------------------------------------------------------
# 5. ROLL BACK - same stop, same start, same checks
# ---------------------------------------------------------------------------------------------------
Say ('The new bridge did not pass: ' + $run.Why + '.') 'Yellow'
if (-not $Backup) {
  Finish 'BRIDGE NEEDS ATTENTION' ('v' + $NewVersion + ' was already installed and did not pass the checks (' + $run.Why + '). Restart the laptop, then tell Claude.') 'Red' 5
}
Say 'Putting the previous version back...' 'Yellow'
$script:Phase = 'putting the previous version back'
$stopped = StopAll 'rollback'
$restored = $false
try { Copy-Item -LiteralPath $Backup -Destination $Target -Force; $restored = ((Sha256Of $Target) -eq $oldHash) } catch { $restored = $false }
if ($restored -and $stopped) {
  $back = StartAndVerify $null 'previous bridge'
  if ($back.Ok) {
    Finish 'ROLLED BACK - previous version is running again' ('The new bridge did not pass (' + $run.Why + '), so the previous one was restored and exactly one is running. Tell Claude.') 'Yellow' 4
  }
  Finish 'ROLLED BACK - but the bridge is NOT running' ('The previous version was put back but did not pass the checks (' + $back.Why + '). Restart the laptop, then tell Claude.') 'Red' 5
}
Finish 'ROLLBACK INCOMPLETE' 'The previous version could not be fully restored. Restart the laptop, then tell Claude.' 'Red' 5

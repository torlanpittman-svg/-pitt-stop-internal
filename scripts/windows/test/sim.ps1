# Simulator for the Windows bridge updater. Runs the BUILT .cmd's PowerShell body under PowerShell 7 on
# any OS with the Windows-only commands replaced by a model of the real laptop:
#   scheduled task -> wscript start-bridge.vbs -> hidden `cmd /c start-bridge.bat` loop -> `node print-bridge.mjs`
# (relative path; relaunched 5 s after it exits). Time is simulated, so a run takes a second or two.
# This is NOT proof of behaviour on Windows - it tests the updater's logic against that model.
param(
  [string]$Cmd, [string]$Root, [string]$OldScript,
  [string]$Initial = 'single',      # single | leftovers | none | keep (reuse state left by the previous run)
  [string]$Net = 'ok',              # ok | down | unauth
  [switch]$NewCrashes,              # the NEW bridge exits 1 s after every launch
  [switch]$JobKill,                 # Stop-ScheduledTask also kills the task's process tree
  [switch]$Emulate51,               # a single process object has no usable .Count (Windows PowerShell 5.1)
  [string]$Printer = 'Brother HL-L2420DW Printer',
  [switch]$Busy, [switch]$NoTask, [switch]$NoBridgeLog,
  [int]$BoomAfter = 0,              # the Nth process listing throws (an unexpected error mid-run)
  [switch]$NoDecoys                 # leave out the unrelated look-alike processes (used to replay the first updater)
)
$ErrorActionPreference = 'Stop'
$t = [IO.File]::ReadAllText($Cmd)
$body = $t.Substring($t.IndexOf('#__PSB_' + 'BEGIN__'))
$dir = Join-Path $Root 'pittstop'
# --- substitutions needed only because this is not Windows ---
$body = $body.Replace("`$DefaultDir      = 'C:\pittstop'", "`$DefaultDir      = '$dir'")
$body = $body.Replace("`$DefaultSumatra  = 'C:\Program Files\SumatraPDF\SumatraPDF.exe'", "`$DefaultSumatra  = '$Root/Sumatra.exe'")
$body = $body.Replace('$identity = [Security.Principal.WindowsIdentity]::GetCurrent()', '$identity = $null')
$body = [regex]::Replace($body, '(?m)^\$isAdmin = .*$', '$isAdmin = $true')
if ($body -notmatch [regex]::Escape("'$dir'")) { throw 'substitution failed' }

$Token = 'SECRETTOKEN-DO-NOT-LEAK-0123456789'
if ($Initial -ne 'keep') {
  Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $dir, "$Root/win/Temp", "$Root/Users/Public", "$Root/Users/shop/AppData/Local/Temp", "$Root/mytemp" | Out-Null
  Copy-Item $OldScript "$dir/print-bridge.mjs"
  [IO.File]::WriteAllText("$dir/print-bridge.config.json", ([char]0xFEFF + (@{ PITTSTOP_BASE_URL = 'https://pitt-stop-internal.vercel.app'; PRINT_BRIDGE_TOKEN = $Token; PRINTER_NAME = $Printer } | ConvertTo-Json)))
  Set-Content "$dir/start-bridge.vbs" 'CreateObject("Wscript.Shell").Run "cmd /c C:\pittstop\start-bridge.bat", 0, False'
  Set-Content "$dir/start-bridge.bat" "@echo off`r`ncd /d C:\pittstop`r`n:loop`r`nnode print-bridge.mjs >> C:\pittstop\bridge.log 2>&1`r`ngoto loop"
  if (-not $NoBridgeLog) { Set-Content "$dir/bridge.log" '[earlier] launching bridge' }
  Set-Content "$Root/Sumatra.exe" 'x'
  foreach ($n in 'pittstop-check-aaa', 'pittstop-check-bbb') { New-Item -ItemType Directory "$Root/Users/shop/AppData/Local/Temp/$n" | Out-Null; Set-Content "$Root/Users/shop/AppData/Local/Temp/$n/job.pdf" 'pdf' }
  New-Item -ItemType Directory "$Root/mytemp/unrelated-dir" | Out-Null; Set-Content "$Root/mytemp/unrelated-dir/keep.pdf" 'keep'
}
$env:SystemRoot = "$Root/win"; $env:PUBLIC = "$Root/Users/Public"; $env:TEMP = "$Root/mytemp"; $env:ComSpec = 'cmd'; $env:COMPUTERNAME = 'LAPTOP-SIM'; $env:PSB_SELF = "$Root/PittStop-Bridge-Update.cmd"
$nodePath = (Get-Command node).Source
$oldHash = (Get-FileHash $OldScript -Algorithm SHA256).Hash

# ---------------- the model ----------------
$global:G = @{ Procs = @(); Now = 0.0; NextPid = 5000; Events = @(); Dir = $dir; Net = $Net; NewCrashes = [bool]$NewCrashes; JobKill = [bool]$JobKill
               Emu = [bool]$Emulate51; OldHash = $oldHash; Node = $nodePath; Kills = @(); Starts = 0; MaxNodes = 0; NoLog = [bool]$NoBridgeLog; Base = [datetime]'2026-10-12T15:00:00' }
function global:SimProc($name, $parent, $cl, $exe) {
  $p = [pscustomobject]@{ ProcessId = [uint32]$G.NextPid; ParentProcessId = [uint32]$parent; Name = $name; CommandLine = $cl; ExecutablePath = $exe; CreationDate = $G.Base.AddSeconds($G.Now); Kind = '' }
  if ($G.Emu) { $p | Add-Member -NotePropertyName Count -NotePropertyValue $null }
  $G.NextPid++; $G.Procs = @($G.Procs) + $p; return $p
}
function global:SimLog($line) { if (-not $G.NoLog) { [IO.File]::AppendAllText("$($G.Dir)/bridge.log", $line + "`r`n") } }
function global:SimAt($delay, [scriptblock]$action) { $G.Events = @($G.Events) + @{ At = $G.Now + $delay; Do = $action } }
function global:SimAlive($id) { @($G.Procs | Where-Object { $_.ProcessId -eq $id }).Count -gt 0 }
function global:SimRemove($id) { $G.Procs = @($G.Procs | Where-Object { $_.ProcessId -ne $id }) }
function global:SimSpawnNode($superId) {
  $n = SimProc 'node.exe' $superId 'node print-bridge.mjs' $G.Node; $n.Kind = 'bridge'
  $nid = $n.ProcessId
  $src = [IO.File]::ReadAllText("$($G.Dir)/print-bridge.mjs")
  $isOld = ((Get-FileHash "$($G.Dir)/print-bridge.mjs" -Algorithm SHA256).Hash -eq $G.OldHash)
  $ver = ''; if ($src -match "BRIDGE_VERSION = '([^']+)'") { $ver = ' v' + $Matches[1] }
  $says = ($src -match 'server accepted')
  SimLog "[sim] launching bridge"
  $em = [char]0x2014
  SimAt 0.5 { if (SimAlive $nid) { SimLog "2026-10-12T20:00:00.000Z Pitt Stop print bridge$ver starting $em LAPTOP-SIM" } }.GetNewClosure()
  if ($G.NewCrashes -and -not $isOld) { SimAt 1.0 { if (SimAlive $nid) { SimRemove $nid; SimNodeGone $superId } }.GetNewClosure(); return }
  SimAt 1.5 {
    if (-not (SimAlive $nid)) { return }
    if ($G.Net -eq 'down') { SimLog '2026-10-12T20:00:01.000Z loop error (will retry): fetch failed' }
    elseif ($G.Net -eq 'unauth') { SimLog "2026-10-12T20:00:01.000Z loop error (will retry): unauthorized $em check PRINT_BRIDGE_TOKEN" }
    elseif ($says) { SimLog "2026-10-12T20:00:01.000Z connected $em server accepted this bridge's token ($($ver.Trim()))" }
  }.GetNewClosure()
}
# the batch loop: 5 s after its node exits, a live supervisor launches another
function global:SimNodeGone($superId) { SimAt 5.0 { if (SimAlive $superId) { SimSpawnNode $superId } }.GetNewClosure() }
function global:SimSpawnSupervisor {
  $w = SimProc 'wscript.exe' 900 ('wscript.exe "' + $G.Dir + '\start-bridge.vbs"') 'C:\Windows\System32\wscript.exe'
  $s = SimProc 'cmd.exe' $w.ProcessId ('cmd /c ' + $G.Dir + '\start-bridge.bat') 'C:\Windows\System32\cmd.exe'; $s.Kind = 'super'
  $wid = $w.ProcessId; SimAt 0.2 { SimRemove $wid }.GetNewClosure()
  SimSpawnNode $s.ProcessId
}
function global:SimKill($id) {
  $p = @($G.Procs | Where-Object { $_.ProcessId -eq $id })
  if ($p.Count -eq 0) { return }
  $G.Kills = @($G.Kills) + ($p[0].Name + ':' + $p[0].CommandLine)
  SimRemove $id
  if ($p[0].Kind -eq 'bridge') { SimNodeGone ([int]$p[0].ParentProcessId) }
}
function global:SimTick($seconds) {
  $end = $G.Now + $seconds
  while ($true) {
    $due = @($G.Events | Where-Object { $_.At -le $end } | Sort-Object { $_.At })
    if ($due.Count -eq 0) { break }
    $e = $due[0]; $G.Events = @($G.Events | Where-Object { $_ -ne $e }); $G.Now = [Math]::Max($G.Now, $e.At); & $e.Do
    $n = @($G.Procs | Where-Object { $_.Kind -eq 'bridge' }).Count; if ($n -gt $G.MaxNodes) { $G.MaxNodes = $n }
  }
  $G.Now = $end
}
# unrelated processes that must never be touched
[void](SimProc 'node.exe' 1 '"C:\Program Files\nodejs\node.exe" C:\other\server.js' $nodePath)
if (-not $NoDecoys) {
  [void](SimProc 'node.exe' 1 'node D:\elsewhere\print-bridge.mjs' $nodePath)
  [void](SimProc 'node.exe' 1 'node my-print-bridge.mjs' $nodePath)
  [void](SimProc 'node.exe' 1 'node print-bridge.mjs.bak' $nodePath)
}
[void](SimProc 'cmd.exe' 1 'cmd /c C:\other\start-bridge.bat' 'cmd.exe')
[void](SimProc 'cmd.exe' 1 'C:\Windows\System32\cmd.exe' 'cmd.exe')
$unrelated = @($G.Procs | ForEach-Object { $_.ProcessId })
if ($Initial -eq 'single' -or $Initial -eq 'keep') { SimSpawnSupervisor }
if ($Initial -eq 'leftovers') { SimSpawnSupervisor; SimSpawnSupervisor; SimSpawnSupervisor }
SimTick 3
$G.Kills = @(); $G.MaxNodes = @($G.Procs | Where-Object { $_.Kind -eq 'bridge' }).Count

# ---------------- stand-ins for the Windows commands ----------------
$global:Listings = 0
function Get-CimInstance { param($Class, $Filter, $ErrorAction)
  $global:Listings++; if ($BoomAfter -gt 0 -and $global:Listings -eq $BoomAfter) { throw 'simulated unexpected failure' }
  if ($Filter -match "Name='([^']+)'") { $want = $Matches[1]; return @($G.Procs | Where-Object { $_.Name -eq $want }) }
  @($G.Procs) }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) SimKill ([int]$Id) }
function Start-Sleep { param($Seconds, $Milliseconds) if ($Milliseconds) { SimTick ($Milliseconds / 1000.0) } else { SimTick $Seconds } }
function Get-ScheduledTask { param($ErrorAction)
  if ($NoTask) { return }
  [pscustomobject]@{ TaskName = 'PittStopPrintBridge'; TaskPath = '\'; State = 'Ready'
    Actions = @([pscustomobject]@{ Execute = 'wscript.exe'; Arguments = '"C:\pittstop\start-bridge.vbs"'; WorkingDirectory = '' })
    Principal = [pscustomobject]@{ UserId = 'shop'; LogonType = 'Interactive'; RunLevel = 'Limited' }
    Settings = [pscustomobject]@{ ExecutionTimeLimit = 'PT72H'; MultipleInstances = 'IgnoreNew' } }
  [pscustomobject]@{ TaskName = 'MsThing'; TaskPath = '\Microsoft\Windows\'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = 'x.exe'; Arguments = 'pittstop'; WorkingDirectory = '' }) }
  [pscustomobject]@{ TaskName = 'ComOnly'; TaskPath = '\'; State = 'Ready'; Actions = @([pscustomobject]@{ Id = 'com' }) }
}
function Start-ScheduledTask { param($TaskName, $TaskPath) $G.Starts++; SimSpawnSupervisor }
function Stop-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction)
  if ($G.JobKill) { foreach ($p in @($G.Procs | Where-Object { $_.Kind -in 'bridge', 'super' })) { SimRemove $p.ProcessId } } }
function Get-Printer { param($Name, $ErrorAction) [pscustomobject]@{ Name = $Name } }
function Get-PrintJob { param($PrinterName, $ErrorAction) if ($Busy) { 1, 2 } }
function Start-Process { throw 'elevation must not be attempted in the simulator' }
function Get-Command { param($Name, $ErrorAction) [pscustomobject]@{ Source = $G.Node } }

$cfgHash = (Get-FileHash "$dir/print-bridge.config.json").Hash
$supHash = (Get-FileHash "$dir/start-bridge.bat").Hash + (Get-FileHash "$dir/start-bridge.vbs").Hash
# Run it as a script file: `exit` then ends the updater only, and the simulator can inspect what is left.
$bodyFile = "$Root/updater-body.ps1"; [IO.File]::WriteAllText($bodyFile, $body)
$global:LASTEXITCODE = $null
try { & $bodyFile; $global:ExitCode = $LASTEXITCODE } catch { Write-Host "SCRIPT ERROR: $_" -ForegroundColor Red; Write-Host $_.ScriptStackTrace; $global:ExitCode = 99 }
SimTick 20   # let the laptop run on: anything that would come back later shows up here

$bridges = @($G.Procs | Where-Object { $_.Kind -eq 'bridge' }); $supers = @($G.Procs | Where-Object { $_.Kind -eq 'super' })
$alive = @($unrelated | Where-Object { SimAlive $_ }).Count
$inst = (Get-FileHash "$dir/print-bridge.mjs" -Algorithm SHA256).Hash
$instV = 'v1 (previous)'; if ((Get-Content "$dir/print-bridge.mjs" -Raw) -match "BRIDGE_VERSION = '([^']+)'") { $instV = 'v' + $Matches[1] }
$logs = ''; foreach ($f in 'bridge-update.log') { if (Test-Path "$dir/$f") { $logs += [IO.File]::ReadAllText("$dir/$f") } }
$diag = "$Root/PittStop-Bridge-Diagnostics.txt"; if (Test-Path $diag) { $logs += [IO.File]::ReadAllText($diag) }
''
"SIM  exit=$($global:ExitCode)  simulated seconds=$([int]$G.Now)  task starts=$($G.Starts)  most bridges at once=$($G.MaxNodes)"
"SIM  final: bridges=$($bridges.Count) supervisors=$($supers.Count)  installed=$instV  unrelated survivors=$alive/$($unrelated.Count)"
"SIM  killed: " + (@($G.Kills | ForEach-Object { ($_ -split ':')[0] }) -join ' ')
"SIM  config unchanged=$((Get-FileHash "$dir/print-bridge.config.json").Hash -eq $cfgHash)  start-bridge.bat/vbs unchanged=$(((Get-FileHash "$dir/start-bridge.bat").Hash + (Get-FileHash "$dir/start-bridge.vbs").Hash) -eq $supHash)  token in logs/diagnostics=$($logs.Contains($Token))"
"SIM  backups: " + (@(Get-ChildItem $dir -Filter 'print-bridge.backup-*' | ForEach-Object { $_.Name + '=' + ((Get-FileHash $_.FullName -Algorithm SHA256).Hash -eq $oldHash) }) -join ' ') + "   leftover pdf dirs=" + @(Get-ChildItem $Root -Recurse -Directory -Filter 'pittstop-check-*').Count + "  stray staged file=" + (Test-Path "$dir/print-bridge.next.mjs")

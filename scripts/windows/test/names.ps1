# Unit test of the updater's "is this command line one of OUR files?" rule, with real Windows-style paths.
param([string]$Cmd)
$t = [IO.File]::ReadAllText($Cmd)
$m = [regex]::Match($t, '(?s)function NamesOurFile\(.*?\r?\n}\r?\n')
if (-not $m.Success) { throw 'NamesOurFile not found' }
Invoke-Expression $m.Value
$script:Dir = 'C:\pittstop'
$cases = @(
  @('node print-bridge.mjs', 'print-bridge.mjs', $true, 'the real launch: relative path'),
  @('"C:\Program Files\nodejs\node.exe" print-bridge.mjs', 'print-bridge.mjs', $true, 'full node path, relative script'),
  @('node C:\pittstop\print-bridge.mjs', 'print-bridge.mjs', $true, 'absolute path into our folder'),
  @('node "c:\PITTSTOP\print-bridge.mjs"', 'print-bridge.mjs', $true, 'quoted, different case'),
  @('C:\nodejs\node.exe C:\pittstop\print-bridge.mjs', 'print-bridge.mjs', $true, 'unquoted node path then our path'),
  @('node .\print-bridge.mjs', 'print-bridge.mjs', $true, 'dot-relative'),
  @('node C:/pittstop/print-bridge.mjs', 'print-bridge.mjs', $true, 'forward slashes'),
  @('node D:\elsewhere\print-bridge.mjs', 'print-bridge.mjs', $false, 'same name in another folder'),
  @('node C:\pittstop-old\print-bridge.mjs', 'print-bridge.mjs', $false, 'look-alike folder'),
  @('node C:\x\pittstop\print-bridge.mjs', 'print-bridge.mjs', $false, 'our folder name nested elsewhere'),
  @('node my-print-bridge.mjs', 'print-bridge.mjs', $false, 'longer file name (prefix)'),
  @('node print-bridge.mjs.bak', 'print-bridge.mjs', $false, 'longer file name (suffix)'),
  @('node C:\other\server.js', 'print-bridge.mjs', $false, 'unrelated node app'),
  @('node server.js --name print-bridge.mjs.old', 'print-bridge.mjs', $false, 'mentioned inside another word'),
  @('cmd /c C:\pittstop\start-bridge.bat', 'start-bridge.bat', $true, 'the real supervisor'),
  @('C:\WINDOWS\system32\cmd.exe /c "C:\pittstop\start-bridge.bat"', 'start-bridge.bat', $true, 'supervisor, quoted'),
  @('cmd /c C:\other\start-bridge.bat', 'start-bridge.bat', $false, 'someone else''s supervisor'),
  @('"C:\WINDOWS\System32\WScript.exe" "C:\pittstop\start-bridge.vbs"', 'start-bridge.vbs', $true, 'the real launcher'),
  @('cmd /c ""C:\Users\shop\Downloads\PittStop-Bridge-Update-R2.cmd""', 'start-bridge.bat', $false, 'the updater itself'),
  @('', 'print-bridge.mjs', $false, 'no command line visible')
)
$bad = 0
foreach ($c in $cases) {
  $got = [bool](NamesOurFile $c[0] $c[1])
  $mark = 'ok  '; if ($got -ne $c[2]) { $mark = 'FAIL'; $bad++ }
  '{0} {1,-5} {2,-34} {3}' -f $mark, $got, $c[3], $c[0]
}
"$($cases.Count - $bad)/$($cases.Count) passed"; exit $bad

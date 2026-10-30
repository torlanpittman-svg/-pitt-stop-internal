@echo off
setlocal
title Pitt Stop print bridge update
set "PSB_SELF=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:PSB_SELF); $i=$t.IndexOf('#__PSB_'+'BEGIN__'); if($i -lt 0){Write-Host 'This update file is damaged.'; exit 9}; & ([scriptblock]::Create($t.Substring($i)))"
set "PSB_RC=%ERRORLEVEL%"
if "%PSB_RC%"=="77" exit /b 0
echo.
echo You can close this window.
pause >nul
exit /b %PSB_RC%
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
$NewVersion      = '2.1.0'
$PayloadSha256   = 'd1706241a2911b346614f1a51a65f8fe2e57d554f465de9394ae2139b423d26c'
$PayloadB64 = @'
IyEvdXNyL2Jpbi9lbnYgbm9kZQovKioKICogUGl0dCBTdG9wIFBSSU5UIEJSSURHRSBhZ2VudCDi
gJQgdGhlIHBlcm1hbmVudCwgYWx3YXlzLW9uIGxpbmsgYmV0d2VlbiB0aGUgUGl0dCBTdG9wIE9T
IGNsb3VkIHByaW50CiAqIHF1ZXVlIGFuZCB0aGUgc2hvcCdzIHByaW50ZXJzOiB0aGUgQnJvdGhl
ciBITC1MMjQyMERXIChjaGVja3MpIGFuZCwgd2hlbiBjb25maWd1cmVkLCB0aGUKICogQnJvdGhl
ciBRTC04MDAgbGFiZWwgcHJpbnRlciAob2lsLWNoYW5nZSBzdGlja2VycykuIFJ1bnMgdW5hdHRl
bmRlZCBvbiB0aGUgYWx3YXlzLW9uIHNob3AgbGFwdG9wIChtYWNPUyBvcgogKiBXaW5kb3dzKS4g
VGhlIHNhbWUgc2NyaXB0IHJ1bnMgb24gdGhlIE1hY0Jvb2sgVE9EQVkgYXMgYSB0ZW1wb3Jhcnkg
YnJpZGdlIOKAlCBubyBjb2RlIGNoYW5nZXMgdG8gbW92ZSBpdC4KICoKICogTG9vcDogIFBPU1Qg
L2FwaS9wcmludC1icmlkZ2UvY2xhaW0gIOKGkiBpZiBhIGpvYiwgZGVjb2RlIGl0cyBQREYsIHBy
aW50IGl0LCBQT1NUIC9hcGkvcHJpbnQtYnJpZGdlL3Jlc3VsdC4KICogU2FmZXR5OgogKiAgIC0g
QXV0aGVudGljYXRlcyB3aXRoIFBSSU5UX0JSSURHRV9UT0tFTiAoQmVhcmVyKS4gUHVsbHMgT05M
WSBQaXR0IFN0b3AgcHJpbnQgam9icy4KICogICAtIFRoZSBzZXJ2ZXIgaGFuZHMgb3V0IGVhY2gg
am9iIHRvIGV4YWN0bHkgb25lIGJyaWRnZSAoYXRvbWljLCBza2lwLWxvY2tlZCkg4oaSIG5vIGR1
cGxpY2F0ZSBwcmludHMuCiAqICAgLSBFdmVyeSBwb2xsIGlzIGFsc28gdGhlIGJyaWRnZSdzIEhF
QVJUQkVBVCAoaWQsIHZlcnNpb24sIHN0YXJ0IHRpbWUpIHNvIHRoZSBhcHAgY2FuIHNob3cgaXQg
b25saW5lLgogKiAgIC0gSXQgcmVwb3J0cyB3aGF0IGl0IGFjdHVhbGx5IGtub3dzOiAnc3VibWl0
dGVkJyAodGhlIHByaW50ZXIgZHJpdmVyIGFjY2VwdGVkIHRoZSBqb2Ig4oCUIE5PVCBwcm9vZiBv
ZgogKiAgICAgcGFwZXI7IGEgbWFuYWdlciBjb25maXJtcyB0aGF0IGluIHRoZSBhcHApLCAnZmFp
bGVkJyAobm90aGluZyB3aWxsIHByaW50KSwgb3IgJ3VuY2VydGFpbicuCiAqICAgICBPbiBXaW5k
b3dzIGl0IHdhdGNoZXMgdGhlIHByaW50IHNwb29sZXI6IGEgam9iIHRoZSBwcmludGVyIG5ldmVy
IHRha2VzIGlzIGNhbmNlbGxlZCBhbmQgcmVwb3J0ZWQKICogICAgIGZhaWxlZCBpbnN0ZWFkIG9m
IHByaW50aW5nIGJ5IHN1cnByaXNlIGxhdGVyLgogKiAgIC0gVGhlIGNoZWNrIFBERiBleGlzdHMg
b24gZGlzayBvbmx5IHdoaWxlIHByaW50aW5nIGFuZCBpcyBkZWxldGVkIGFmdGVyd2FyZHMgKGFu
ZCBvbiBzdGFydHVwKS4KICogICAtIFF1ZXVlZCBqb2JzIGV4cGlyZSBzZXJ2ZXItc2lkZSwgc28g
YW4gb3V0YWdlIG5ldmVyIGNhdXNlcyBhIGxhdGUsIHVuYXR0ZW5kZWQgcHJpbnQuCiAqICAgLSBJ
dCBsb2dzIG9uY2Ugd2hlbiB0aGUgc2VydmVyIGFjY2VwdHMgaXRzIHRva2VuICgiY29ubmVjdGVk
IiksIGFuZCBhZ2FpbiBhZnRlciBhbnkgb3V0YWdlLCBzbyB0aGUKICogICAgIGxvZyBzaG93cyB3
aGV0aGVyIGl0IGlzIHJlYWxseSB0YWxraW5nIHRvIFBpdHQgU3RvcCBPUyAodGhlIFdpbmRvd3Mg
dXBkYXRlciByZWFkcyB0aGlzIGxpbmUpLgogKiAgIC0gUFJJTlRFUiBST1VUSU5HIElTIEVYUExJ
Q0lULCBORVZFUiBUSEUgV0lORE9XUyBERUZBVUxUOiBjaGVjay1mYW1pbHkgam9icyBhbHdheXMg
cHJpbnQgdG8KICogICAgIFBSSU5URVJfTkFNRTsgJ3N0aWNrZXInIGpvYnMgYWx3YXlzIHByaW50
IHRvIExBQkVMX1BSSU5URVJfTkFNRS4gVGhlIHNlcnZlciBvbmx5IGhhbmRzIHRoaXMKICogICAg
IGJyaWRnZSBzdGlja2VyIGpvYnMgd2hlbiBpdCBkZWNsYXJlcyBhIGxhYmVsIHByaW50ZXIsIGFu
ZCB0aGUgYnJpZGdlIGRvdWJsZS1jaGVja3M6IGEgc3RpY2tlcgogKiAgICAgam9iIHdpdGggbm8g
bGFiZWwgcHJpbnRlciBjb25maWd1cmVkIGlzIHJlcG9ydGVkIGZhaWxlZCwgbmV2ZXIgcHJpbnRl
ZCBlbHNld2hlcmUuCiAqICAgLSBObyBidXNpbmVzcyBsb2dpYywgbm8gYXJiaXRyYXJ5IGNvbW1h
bmRzIOKAlCBpdCBwcmludHMgYnl0ZXMgYW5kIHJlcG9ydHMgc3RhdHVzLgogKgogKiBDb25maWcg
KGVudiBPUiBhIHByaW50LWJyaWRnZS5jb25maWcuanNvbiBuZXh0IHRvIHRoaXMgc2NyaXB0OyBl
bnYgd2lucyk6CiAqICAgUElUVFNUT1BfQkFTRV9VUkwgICBlLmcuIGh0dHBzOi8veW91ci1waXR0
LXN0b3Atb3MudmVyY2VsLmFwcCAgIChyZXF1aXJlZCkKICogICBQUklOVF9CUklER0VfVE9LRU4g
IHRoZSBzaGFyZWQgYnJpZGdlIHNlY3JldCAgICAgICAgICAgICAgICAgICAgIChyZXF1aXJlZCwg
bWF0Y2hlcyBzZXJ2ZXIgZW52KQogKiAgIFBSSU5URVJfTkFNRSAgICAgICAgQ1VQUy9XaW5kb3dz
IHByaW50ZXIgbmFtZSAgKGRlZmF1bHQ6IEJyb3RoZXJfSExfTDI0MjBEVykKICogICBCUklER0Vf
SUQgICAgICAgICAgIGlkZW50aWZpZXIgZm9yIGxvZ3MgICAgICAgIChkZWZhdWx0OiBob3N0bmFt
ZSkKICogICBQT0xMX1NFQ09ORFMgICAgICAgIGlkbGUgcG9sbCBpbnRlcnZhbCAgICAgICAgIChk
ZWZhdWx0OiA1KQogKiAgIFNVTUFUUkFfUEFUSCAgICAgICAgV2luZG93cyBvbmx5OiBwYXRoIHRv
IFN1bWF0cmFQREYuZXhlIGZvciBzaWxlbnQgUERGIHByaW50aW5nCiAqICAgU1BPT0xfV0FJVF9T
RUNPTkRTICBXaW5kb3dzIG9ubHk6IGhvdyBsb25nIHRvIHdhaXQgZm9yIHRoZSBwcmludGVyIHRv
IHRha2UgYSBqb2IgKGRlZmF1bHQ6IDc1KQogKiAgIExBQkVMX1BSSU5URVJfTkFNRSAgT1BUSU9O
QUw6IGV4YWN0IFdpbmRvd3MvQ1VQUyBuYW1lIG9mIHRoZSBsYWJlbCBwcmludGVyIChlLmcuICJC
cm90aGVyIFFMLTgwMCIpLgogKiAgICAgICAgICAgICAgICAgICAgICAgVW5zZXQgPSB0aGlzIGJy
aWRnZSBuZXZlciByZWNlaXZlcyBzdGlja2VyIGpvYnMuCiAqICAgTEFCRUxfUFJJTlRfU0VUVElO
R1MgU3VtYXRyYVBERiAtcHJpbnQtc2V0dGluZ3MgZm9yIGxhYmVscyAoZGVmYXVsdDogIm5vc2Nh
bGUscGFwZXI9YXV0byIg4oCUIHRoZQogKiAgICAgICAgICAgICAgICAgICAgICAgUERGIHBhZ2Ug
SVMgdGhlIGxhYmVsIHNpemUsIHNvIHRoZSBkcml2ZXIgY3V0cyB0aGUgY29udGludW91cyByb2xs
IHRvIG1hdGNoKQogKgogKiBVc2FnZTogIG5vZGUgc2NyaXB0cy9wcmludC1icmlkZ2UubWpzCiAq
LwppbXBvcnQgeyByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMsIG1rZHRlbXBTeW5jLCBleGlz
dHNTeW5jLCBybVN5bmMsIHJlYWRkaXJTeW5jIH0gZnJvbSAnbm9kZTpmcycKaW1wb3J0IHsgdG1w
ZGlyLCBob3N0bmFtZSB9IGZyb20gJ25vZGU6b3MnCmltcG9ydCB7IGpvaW4sIGRpcm5hbWUgfSBm
cm9tICdub2RlOnBhdGgnCmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICdub2RlOnVybCcK
aW1wb3J0IHsgZXhlY0ZpbGUgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnCgpjb25zdCBIRVJF
ID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpCmNvbnN0IEJSSURHRV9W
RVJTSU9OID0gJzIuMS4wJwpjb25zdCBTVEFSVEVEX0FUID0gbmV3IERhdGUoKS50b0lTT1N0cmlu
ZygpCmNvbnN0IFRNUF9QUkVGSVggPSAncGl0dHN0b3AtY2hlY2stJwoKZnVuY3Rpb24gbG9hZENv
bmZpZygpIHsKICBjb25zdCBjZmcgPSB7fQogIGNvbnN0IGZpbGUgPSBqb2luKEhFUkUsICdwcmlu
dC1icmlkZ2UuY29uZmlnLmpzb24nKQogIC8vIFN0cmlwIGEgbGVhZGluZyBVVEYtOCBCT00g4oCU
IFdpbmRvd3MgUG93ZXJTaGVsbCdzIFNldC1Db250ZW50IC1FbmNvZGluZyBVVEY4IHdyaXRlcyBv
bmUsIGFuZAogIC8vIEpTT04ucGFyc2UgcmVqZWN0cyBpdC4gV2l0aG91dCB0aGlzIHRoZSBjb25m
aWcgc2lsZW50bHkgZmFpbHMgdG8gbG9hZCBhbmQgdGhlIGJyaWRnZSBleGl0cy4KICBpZiAoZXhp
c3RzU3luYyhmaWxlKSkgeyB0cnkgeyBPYmplY3QuYXNzaWduKGNmZywgSlNPTi5wYXJzZShyZWFk
RmlsZVN5bmMoZmlsZSwgJ3V0ZjgnKS5yZXBsYWNlKC9eXHVGRUZGLywgJycpKSkgfSBjYXRjaCAo
ZSkgeyBjb25zb2xlLmVycm9yKCdiYWQgY29uZmlnIGpzb246JywgZS5tZXNzYWdlKSB9IH0KICBj
b25zdCBnZXQgPSAoaywgZCkgPT4gcHJvY2Vzcy5lbnZba10gPz8gY2ZnW2tdID8/IGQKICByZXR1
cm4gewogICAgYmFzZVVybDogKGdldCgnUElUVFNUT1BfQkFTRV9VUkwnLCAnJykgfHwgJycpLnJl
cGxhY2UoL1wvJC8sICcnKSwKICAgIHRva2VuOiBnZXQoJ1BSSU5UX0JSSURHRV9UT0tFTicsICcn
KSwKICAgIHByaW50ZXI6IGdldCgnUFJJTlRFUl9OQU1FJywgJ0Jyb3RoZXJfSExfTDI0MjBEVycp
LAogICAgYnJpZGdlSWQ6IGdldCgnQlJJREdFX0lEJywgaG9zdG5hbWUoKSksCiAgICBwb2xsTXM6
IE1hdGgubWF4KDIsIHBhcnNlSW50KGdldCgnUE9MTF9TRUNPTkRTJywgJzUnKSwgMTApIHx8IDUp
ICogMTAwMCwKICAgIHN1bWF0cmE6IGdldCgnU1VNQVRSQV9QQVRIJywgJ0M6XFxQcm9ncmFtIEZp
bGVzXFxTdW1hdHJhUERGXFxTdW1hdHJhUERGLmV4ZScpLAogICAgc3Bvb2xXYWl0U2Vjb25kczog
Z2V0KCdTUE9PTF9XQUlUX1NFQ09ORFMnLCAnNzUnKSwKICAgIGxhYmVsUHJpbnRlcjogZ2V0KCdM
QUJFTF9QUklOVEVSX05BTUUnLCAnJykgfHwgbnVsbCwKICAgIGxhYmVsU2V0dGluZ3M6IGdldCgn
TEFCRUxfUFJJTlRfU0VUVElOR1MnLCAnbm9zY2FsZSxwYXBlcj1hdXRvJyksCiAgfQp9Cgpjb25z
dCBDID0gbG9hZENvbmZpZygpCmNvbnN0IGlzV2luID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dp
bjMyJwoKZnVuY3Rpb24gbG9nKC4uLmEpIHsgY29uc29sZS5sb2cobmV3IERhdGUoKS50b0lTT1N0
cmluZygpLCAuLi5hKSB9CgpmdW5jdGlvbiBleGVjUChjbWQsIGFyZ3MsIHRpbWVvdXRNcyA9IDEy
MDAwMCkgewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICBl
eGVjRmlsZShjbWQsIGFyZ3MsIHsgd2luZG93c0hpZGU6IHRydWUsIHRpbWVvdXQ6IHRpbWVvdXRN
cyB9LCAoZXJyLCBzdGRvdXQsIHN0ZGVycikgPT4gewogICAgICBpZiAoZXJyKSByZXR1cm4gcmVq
ZWN0KG5ldyBFcnJvcihgJHtlcnIubWVzc2FnZX0gJHtzdGRlcnIgfHwgJyd9YC50cmltKCkpKQog
ICAgICByZXNvbHZlKHN0ZG91dCkKICAgIH0pCiAgfSkKfQoKLyoqCiAqIFByaW50IGEgUERGIGZp
bGUgdG8gYW4gRVhQTElDSVRMWSBOQU1FRCBwcmludGVyIG9uIHRoaXMgT1Mg4oCUIG5ldmVyIHRo
ZSBzeXN0ZW0gZGVmYXVsdC4KICogQ2hlY2tzIHVzZSBgbm9zY2FsZWAgKGFjdHVhbCBzaXplIG9u
IHRoZSBjaGVjayBzdG9jayk7IHN0aWNrZXJzIHVzZSBgbm9zY2FsZSxwYXBlcj1hdXRvYAogKiBz
byB0aGUgZHJpdmVyIHRha2VzIHRoZSBwYXBlciBzaXplIGZyb20gdGhlIFBERiBwYWdlICh0aGUg
ZXhhY3QgbGFiZWwgZGltZW5zaW9ucykgYW5kIHRoZQogKiBRTC04MDAgY3V0cyB0aGUgY29udGlu
dW91cyByb2xsIGF0IHRoZSBwYWdlIGVkZ2UuCiAqLwphc3luYyBmdW5jdGlvbiBwcmludFBkZihw
ZGZQYXRoLCBwcmludGVyLCBzZXR0aW5ncykgewogIGlmIChpc1dpbikgewogICAgaWYgKCFleGlz
dHNTeW5jKEMuc3VtYXRyYSkpIHRocm93IG5ldyBFcnJvcihgU3VtYXRyYVBERiBub3QgZm91bmQg
YXQgJHtDLnN1bWF0cmF9LiBJbnN0YWxsIGl0IChmcmVlKSBvciBzZXQgU1VNQVRSQV9QQVRILmAp
CiAgICBhd2FpdCBleGVjUChDLnN1bWF0cmEsIFsnLXByaW50LXRvJywgcHJpbnRlciwgJy1wcmlu
dC1zZXR0aW5ncycsIHNldHRpbmdzLCAnLXNpbGVudCcsICctZXhpdC13aGVuLWRvbmUnLCBwZGZQ
YXRoXSkKICB9IGVsc2UgewogICAgLy8gbWFjT1MgLyBMaW51eDogQ1VQUy4gbHAgaXMgYnVpbHQg
aW4gb24gbWFjT1MuIC1vIGZpdC10by1wYWdlPWZhbHNlIC8gc2NhbGluZz0xMDAga2VlcCBhY3R1
YWwgc2l6ZS4KICAgIGF3YWl0IGV4ZWNQKCdscCcsIFsnLWQnLCBwcmludGVyLCAnLW8nLCAnZml0
LXRvLXBhZ2U9ZmFsc2UnLCAnLW8nLCAnc2NhbGluZz0xMDAnLCBwZGZQYXRoXSkKICB9Cn0KCi8q
KiBXaGljaCBwcmludGVyICsgc2V0dGluZ3MgYSBqb2IgcHJpbnRzIHdpdGguIFN0aWNrZXIgam9i
cyBSRVFVSVJFIHRoZSBsYWJlbCBwcmludGVyLiAqLwpmdW5jdGlvbiByb3V0ZUpvYihqb2IpIHsK
ICBpZiAoam9iLmtpbmQgPT09ICdzdGlja2VyJykgewogICAgaWYgKCFDLmxhYmVsUHJpbnRlcikg
cmV0dXJuIHsgZXJyb3I6ICdUaGlzIGJyaWRnZSBoYXMgbm8gTEFCRUxfUFJJTlRFUl9OQU1FIGNv
bmZpZ3VyZWQg4oCUIHN0aWNrZXIgcmVmdXNlZCAobmV2ZXIgcHJpbnRlZCBvbiB0aGUgY2hlY2sg
cHJpbnRlcikuJyB9CiAgICByZXR1cm4geyBwcmludGVyOiBDLmxhYmVsUHJpbnRlciwgc2V0dGlu
Z3M6IEMubGFiZWxTZXR0aW5ncyB9CiAgfQogIHJldHVybiB7IHByaW50ZXI6IEMucHJpbnRlciwg
c2V0dGluZ3M6ICdub3NjYWxlJyB9Cn0KCmFzeW5jIGZ1bmN0aW9uIGFwaShwYXRoLCBib2R5KSB7
CiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7Qy5iYXNlVXJsfSR7cGF0aH1gLCB7CiAgICBt
ZXRob2Q6ICdQT1NUJywKICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlv
bi9qc29uJywgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke0MudG9rZW59YCB9LAogICAgYm9keTog
SlNPTi5zdHJpbmdpZnkoYm9keSB8fCB7fSksCiAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVv
dXQoMzAwMDApLAogIH0pCiAgY29uc3QgdGV4dCA9IGF3YWl0IHJlcy50ZXh0KCkKICBsZXQganNv
biA9IHt9CiAgdHJ5IHsganNvbiA9IHRleHQgPyBKU09OLnBhcnNlKHRleHQpIDoge30gfSBjYXRj
aCB7IC8qIG5vbi1qc29uICovIH0KICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGpzb24g
fQp9CgovKiogUmVtb3ZlIGEgdGVtcCBkaXIgaG9sZGluZyBhIGNoZWNrIFBERi4gTmV2ZXIgdGhy
b3dzLiAqLwpmdW5jdGlvbiByZW1vdmVEaXIoZGlyKSB7IHRyeSB7IHJtU3luYyhkaXIsIHsgcmVj
dXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8g
fSB9CgovKiogU3RhcnR1cCBzd2VlcDogZGVsZXRlIGFueSBjaGVjayBQREZzIGEgcHJldmlvdXMg
cnVuIGxlZnQgYmVoaW5kIChjcmFzaCAvIHBvd2VyIGxvc3MpLiAqLwpmdW5jdGlvbiBzd2VlcFRl
bXAoKSB7CiAgdHJ5IHsKICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyh0bXBkaXIo
KSkpIGlmIChuYW1lLnN0YXJ0c1dpdGgoVE1QX1BSRUZJWCkpIHJlbW92ZURpcihqb2luKHRtcGRp
cigpLCBuYW1lKSkKICB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfQp9Cgpjb25zdCBwc1F1
b3RlID0gKHMpID0+IGAnJHtTdHJpbmcocykucmVwbGFjZSgvJy9nLCAiJyciKX0nYAovKiogSG93
IG1hbnkgc3Bvb2xlciBqb2JzIG9uIHRoZSBnaXZlbiBwcmludGVyIGJlbG9uZyB0byB0aGlzIGRv
Y3VtZW50IChXaW5kb3dzKS4gVGhyb3dzIGlmIGl0IGNhbm5vdCB0ZWxsLiAqLwphc3luYyBmdW5j
dGlvbiBzcG9vbENvdW50KHByaW50ZXIsIGRvY1RhZykgewogIGNvbnN0IG91dCA9IGF3YWl0IGV4
ZWNQKCdwb3dlcnNoZWxsLmV4ZScsIFsnLU5vUHJvZmlsZScsICctTm9uSW50ZXJhY3RpdmUnLCAn
LUNvbW1hbmQnLAogICAgYEAoR2V0LVByaW50Sm9iIC1QcmludGVyTmFtZSAke3BzUXVvdGUocHJp
bnRlcil9IC1FcnJvckFjdGlvbiBTdG9wIHwgV2hlcmUtT2JqZWN0IHsgJF8uRG9jdW1lbnROYW1l
IC1saWtlICR7cHNRdW90ZSgnKicgKyBkb2NUYWcgKyAnKicpfSB9KS5Db3VudGBdLCAyMDAwMCkK
ICBjb25zdCBuID0gcGFyc2VJbnQoU3RyaW5nKG91dCkudHJpbSgpLCAxMCkKICBpZiAoIU51bWJl
ci5pc0Zpbml0ZShuKSkgdGhyb3cgbmV3IEVycm9yKCd1bnJlYWRhYmxlIHNwb29sZXIgYW5zd2Vy
JykKICByZXR1cm4gbgp9CmFzeW5jIGZ1bmN0aW9uIHNwb29sQ2FuY2VsKHByaW50ZXIsIGRvY1Rh
ZykgewogIGF3YWl0IGV4ZWNQKCdwb3dlcnNoZWxsLmV4ZScsIFsnLU5vUHJvZmlsZScsICctTm9u
SW50ZXJhY3RpdmUnLCAnLUNvbW1hbmQnLAogICAgYEdldC1QcmludEpvYiAtUHJpbnRlck5hbWUg
JHtwc1F1b3RlKHByaW50ZXIpfSAtRXJyb3JBY3Rpb24gU3RvcCB8IFdoZXJlLU9iamVjdCB7ICRf
LkRvY3VtZW50TmFtZSAtbGlrZSAke3BzUXVvdGUoJyonICsgZG9jVGFnICsgJyonKX0gfSB8IFJl
bW92ZS1QcmludEpvYiAtRXJyb3JBY3Rpb24gU3RvcGBdLCAyMDAwMCkKfQoKLyoqCiAqIEFmdGVy
IHRoZSBkcml2ZXIgYWNjZXB0ZWQgdGhlIGpvYiwgd2F0Y2ggdGhlIFdpbmRvd3Mgc3Bvb2xlciB1
bnRpbCB0aGUgcHJpbnRlciBoYXMgdGFrZW4gaXQuCiAqICAgbGVmdCB0aGUgc3Bvb2xlciAgICAg
ICAgICAgICDihpIgJ3N1Ym1pdHRlZCcKICogICBzdGlsbCBzdHVjayBhZnRlciB0aGUgd2FpdCAg
IOKGkiBjYW5jZWwgaXQ7IGlmIHRoZSBjYW5jZWwgaXMgY29uZmlybWVkIOKGkiAnZmFpbGVkJyAo
aXQgd2lsbCBOT1QgcHJpbnQKICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGF0
ZXIpLCBvdGhlcndpc2Ug4oaSICd1bmNlcnRhaW4nIChhIHBlcnNvbiBtdXN0IGxvb2spCiAqICAg
c3Bvb2xlciBjYW5ub3QgYmUgcXVlcmllZCAgICDihpIgJ3N1Ym1pdHRlZCcgd2l0aCBhIG5vdGUg
KGEgbWFuYWdlciBjb25maXJtcyBwYXBlciBlaXRoZXIgd2F5KQogKi8KYXN5bmMgZnVuY3Rpb24g
d2F0Y2hTcG9vbGVyKHByaW50ZXIsIGRvY1RhZykgewogIGlmICghaXNXaW4pIHJldHVybiB7IG91
dGNvbWU6ICdzdWJtaXR0ZWQnIH0KICBjb25zdCB3YWl0TXMgPSBNYXRoLm1heCgxNSwgcGFyc2VJ
bnQoQy5zcG9vbFdhaXRTZWNvbmRzLCAxMCkgfHwgNzUpICogMTAwMAogIGNvbnN0IGRlYWRsaW5l
ID0gRGF0ZS5ub3coKSArIHdhaXRNcwogIHRyeSB7CiAgICBmb3IgKDs7KSB7CiAgICAgIGlmICgo
YXdhaXQgc3Bvb2xDb3VudChwcmludGVyLCBkb2NUYWcpKSA9PT0gMCkgcmV0dXJuIHsgb3V0Y29t
ZTogJ3N1Ym1pdHRlZCcgfQogICAgICBpZiAoRGF0ZS5ub3coKSA+PSBkZWFkbGluZSkgYnJlYWsK
ICAgICAgYXdhaXQgc2xlZXAoMzAwMCkKICAgIH0KICB9IGNhdGNoIChlKSB7CiAgICByZXR1cm4g
eyBvdXRjb21lOiAnc3VibWl0dGVkJywgbm90ZTogYHNwb29sZXIgbm90IHJlYWRhYmxlICgke2Uu
bWVzc2FnZX0pYCB9CiAgfQogIHRyeSB7CiAgICBhd2FpdCBzcG9vbENhbmNlbChwcmludGVyLCBk
b2NUYWcpCiAgICBhd2FpdCBzbGVlcCgyMDAwKQogICAgaWYgKChhd2FpdCBzcG9vbENvdW50KHBy
aW50ZXIsIGRvY1RhZykpID09PSAwKSByZXR1cm4geyBvdXRjb21lOiAnZmFpbGVkJywgZXJyb3I6
ICdUaGUgcHJpbnRlciBkaWQgbm90IHRha2UgdGhlIGpvYiAob2ZmbGluZSwgb3V0IG9mIHBhcGVy
LCBvciBqYW1tZWQ/KS4gSXQgd2FzIGNhbmNlbGxlZCBhbmQgd2lsbCBub3QgcHJpbnQgbGF0ZXIu
JyB9CiAgfSBjYXRjaCB7IC8qIGZhbGwgdGhyb3VnaCB0byB1bmNlcnRhaW4gKi8gfQogIHJldHVy
biB7IG91dGNvbWU6ICd1bmNlcnRhaW4nLCBlcnJvcjogJ1RoZSBqb2IgaXMgc3R1Y2sgaW4gdGhl
IFdpbmRvd3MgcHJpbnQgcXVldWUgYW5kIGNvdWxkIG5vdCBiZSBjYW5jZWxsZWQuIENoZWNrIHRo
ZSBwcmludGVyIGJlZm9yZSBzZW5kaW5nIGFnYWluLicgfQp9CgovKiogUmVwb3J0IGEgam9iIG91
dGNvbWU7IHJldHJpZWQsIGJlY2F1c2UgYSBsb3N0IHJlcG9ydCBsZWF2ZXMgdGhlIGpvYiBvcGVu
IGZvciBhIG1hbmFnZXIgdG8gc2V0dGxlLiAqLwphc3luYyBmdW5jdGlvbiByZXBvcnQoam9iSWQs
IG91dGNvbWUsIGVycm9yKSB7CiAgZm9yIChsZXQgYXR0ZW1wdCA9IDE7IGF0dGVtcHQgPD0gNTsg
YXR0ZW1wdCsrKSB7CiAgICB0cnkgewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvYXBpL3By
aW50LWJyaWRnZS9yZXN1bHQnLCB7IGpvYklkLCBvdXRjb21lLCBzdWNjZXNzOiBvdXRjb21lID09
PSAnc3VibWl0dGVkJywgZXJyb3I6IGVycm9yIHx8IHVuZGVmaW5lZCwgYnJpZGdlSWQ6IEMuYnJp
ZGdlSWQgfSkKICAgICAgaWYgKHIuc3RhdHVzID09PSAyMDApIHJldHVybiB0cnVlCiAgICAgIGxv
ZyhgcmVwb3J0ICR7am9iSWR9IOKGkiBIVFRQICR7ci5zdGF0dXN9IChhdHRlbXB0ICR7YXR0ZW1w
dH0pYCkKICAgIH0gY2F0Y2ggKGUpIHsgbG9nKGByZXBvcnQgJHtqb2JJZH0gZmFpbGVkIChhdHRl
bXB0ICR7YXR0ZW1wdH0pOiAke2UubWVzc2FnZX1gKSB9CiAgICBhd2FpdCBzbGVlcChhdHRlbXB0
ICogMzAwMCkKICB9CiAgbG9nKGBjb3VsZCBOT1QgcmVwb3J0IGpvYiAke2pvYklkfSAoJHtvdXRj
b21lfSkg4oCUIGEgbWFuYWdlciB3aWxsIG5lZWQgdG8gc2V0dGxlIGl0IGluIHRoZSBhcHBgKQog
IHJldHVybiBmYWxzZQp9CgpsZXQgY29ubmVjdGVkID0gZmFsc2UgLy8gbG9nZ2VkIG9uY2UgcGVy
IChyZSljb25uZWN0aW9uLCBuZXZlciBwZXIgcG9sbAoKYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc09u
ZSgpIHsKICBjb25zdCBjbGFpbSA9IGF3YWl0IGFwaSgnL2FwaS9wcmludC1icmlkZ2UvY2xhaW0n
LCB7IGJyaWRnZUlkOiBDLmJyaWRnZUlkLCB2ZXJzaW9uOiBCUklER0VfVkVSU0lPTiwgcGxhdGZv
cm06IHByb2Nlc3MucGxhdGZvcm0sIHByaW50ZXI6IEMucHJpbnRlciwgbGFiZWxQcmludGVyOiBD
LmxhYmVsUHJpbnRlciwgc3RhcnRlZEF0OiBTVEFSVEVEX0FUIH0pCiAgaWYgKGNsYWltLnN0YXR1
cyA9PT0gNDAxKSB0aHJvdyBuZXcgRXJyb3IoJ3VuYXV0aG9yaXplZCDigJQgY2hlY2sgUFJJTlRf
QlJJREdFX1RPS0VOJykKICBpZiAoY2xhaW0uc3RhdHVzID09PSA1MDMpIHsgcmV0dXJuIGZhbHNl
IH0gLy8gYnJpZGdlIG5vdCBjb25maWd1cmVkIG9uIHNlcnZlciB5ZXQKICBpZiAoY2xhaW0uc3Rh
dHVzICE9PSAyMDApIHRocm93IG5ldyBFcnJvcihgY2xhaW0gZmFpbGVkOiBIVFRQICR7Y2xhaW0u
c3RhdHVzfWApCiAgaWYgKCFjb25uZWN0ZWQpIHsgY29ubmVjdGVkID0gdHJ1ZTsgbG9nKGBjb25u
ZWN0ZWQg4oCUIHNlcnZlciBhY2NlcHRlZCB0aGlzIGJyaWRnZSdzIHRva2VuICh2JHtCUklER0Vf
VkVSU0lPTn0pYCkgfQogIGNvbnN0IGpvYiA9IGNsYWltLmpzb24uam9iCiAgaWYgKCFqb2IpIHJl
dHVybiBmYWxzZSAvLyBxdWV1ZSBlbXB0eSAob3IgdGhlIHNlcnZlciByZWZ1c2VkIHRoZSBqb2Ip
CgogIGxvZyhgY2xhaW1lZCBqb2IgJHtqb2IuaWR9ICgke2pvYi5raW5kfSlgKQogIGNvbnN0IHJv
dXRlID0gcm91dGVKb2Ioam9iKQogIGlmIChyb3V0ZS5lcnJvcikgewogICAgbG9nKGBqb2IgJHtq
b2IuaWR9OiByZWZ1c2VkIOKAlCAke3JvdXRlLmVycm9yfWApCiAgICBhd2FpdCByZXBvcnQoam9i
LmlkLCAnZmFpbGVkJywgcm91dGUuZXJyb3IpCiAgICByZXR1cm4gdHJ1ZQogIH0KICBsZXQgZGly
ID0gbnVsbAogIHRyeSB7CiAgICBpZiAoIWNsYWltLmpzb24ucGRmQmFzZTY0KSB0aHJvdyBuZXcg
RXJyb3IoJ2NsYWltIGNhcnJpZWQgbm8gUERGJykKICAgIGRpciA9IG1rZHRlbXBTeW5jKGpvaW4o
dG1wZGlyKCksIFRNUF9QUkVGSVgpKQogICAgY29uc3QgcGRmUGF0aCA9IGpvaW4oZGlyLCBgJHtq
b2IuaWR9LnBkZmApCiAgICB3cml0ZUZpbGVTeW5jKHBkZlBhdGgsIEJ1ZmZlci5mcm9tKGNsYWlt
Lmpzb24ucGRmQmFzZTY0LCAnYmFzZTY0JykpCiAgICBhd2FpdCBwcmludFBkZihwZGZQYXRoLCBy
b3V0ZS5wcmludGVyLCByb3V0ZS5zZXR0aW5ncykKICAgIGNvbnN0IHNwb29sID0gYXdhaXQgd2F0
Y2hTcG9vbGVyKHJvdXRlLnByaW50ZXIsIGpvYi5pZCkKICAgIGxvZyhgam9iICR7am9iLmlkfTog
JHtzcG9vbC5vdXRjb21lfSR7c3Bvb2wuZXJyb3IgPyAnIOKAlCAnICsgc3Bvb2wuZXJyb3IgOiAn
J30ke3Nwb29sLm5vdGUgPyAnICgnICsgc3Bvb2wubm90ZSArICcpJyA6ICcnfWApCiAgICBhd2Fp
dCByZXBvcnQoam9iLmlkLCBzcG9vbC5vdXRjb21lLCBzcG9vbC5lcnJvciB8fCBzcG9vbC5ub3Rl
KQogIH0gY2F0Y2ggKGUpIHsKICAgIC8vIFRoZSBwcmludCBjb21tYW5kIGl0c2VsZiBmYWlsZWQg
b3IgdGltZWQgb3V0LiBBIHRpbWVvdXQgZG9lcyBub3QgcHJvdmUgbm90aGluZyBwcmludGVkLgog
ICAgY29uc3QgdGltZWRPdXQgPSAvdGltZWQ/ID9vdXR8RVRJTUVET1VUfGtpbGxlZC9pLnRlc3Qo
U3RyaW5nKGUubWVzc2FnZSkpCiAgICBsb2coYHByaW50ICR7dGltZWRPdXQgPyAnVU5DRVJUQUlO
JyA6ICdGQUlMRUQnfSBqb2IgJHtqb2IuaWR9OiAke2UubWVzc2FnZX1gKQogICAgYXdhaXQgcmVw
b3J0KGpvYi5pZCwgdGltZWRPdXQgPyAndW5jZXJ0YWluJyA6ICdmYWlsZWQnLCBlLm1lc3NhZ2Up
CiAgfSBmaW5hbGx5IHsKICAgIGlmIChkaXIpIHJlbW92ZURpcihkaXIpIC8vIG5ldmVyIGxlYXZl
IGEgY2hlY2sgUERGIG9uIGRpc2sKICB9CiAgcmV0dXJuIHRydWUKfQoKYXN5bmMgZnVuY3Rpb24g
bWFpbigpIHsKICBpZiAoIUMuYmFzZVVybCB8fCAhQy50b2tlbikgewogICAgY29uc29sZS5lcnJv
cignTWlzc2luZyBQSVRUU1RPUF9CQVNFX1VSTCBvciBQUklOVF9CUklER0VfVE9LRU4uIFNldCBl
bnYgdmFycyBvciBzY3JpcHRzL3ByaW50LWJyaWRnZS5jb25maWcuanNvbi4nKQogICAgcHJvY2Vz
cy5leGl0KDEpCiAgfQogIHN3ZWVwVGVtcCgpCiAgbG9nKGBQaXR0IFN0b3AgcHJpbnQgYnJpZGdl
IHYke0JSSURHRV9WRVJTSU9OfSBzdGFydGluZyDigJQgJHtDLmJyaWRnZUlkfSDihpIgJHtDLnBy
aW50ZXJ9JHtDLmxhYmVsUHJpbnRlciA/IGAgKyBsYWJlbHMg4oaSICR7Qy5sYWJlbFByaW50ZXJ9
YCA6ICcgKG5vIGxhYmVsIHByaW50ZXIpJ30gKCR7aXNXaW4gPyAnd2luZG93cycgOiBwcm9jZXNz
LnBsYXRmb3JtfSkg4oaSICR7Qy5iYXNlVXJsfWApCiAgLy8gRm9yZXZlciBsb29wOyBuZXZlciBj
cmFzaGVzIG9uIHRyYW5zaWVudCBlcnJvcnMgKG91dGFnZS1zYWZlKS4KICBmb3IgKDs7KSB7CiAg
ICB0cnkgewogICAgICBjb25zdCBkaWRXb3JrID0gYXdhaXQgcHJvY2Vzc09uZSgpCiAgICAgIGlm
ICghZGlkV29yaykgYXdhaXQgc2xlZXAoQy5wb2xsTXMpCiAgICAgIGVsc2UgYXdhaXQgc2xlZXAo
NDAwKSAvLyBkcmFpbiB0aGUgcXVldWUgcXVpY2tseSB3aGVuIGJ1c3kKICAgIH0gY2F0Y2ggKGUp
IHsKICAgICAgY29ubmVjdGVkID0gZmFsc2UKICAgICAgbG9nKGBsb29wIGVycm9yICh3aWxsIHJl
dHJ5KTogJHtlLm1lc3NhZ2V9YCkKICAgICAgYXdhaXQgc2xlZXAoTWF0aC5tYXgoQy5wb2xsTXMs
IDUwMDApKQogICAgfQogIH0KfQpjb25zdCBzbGVlcCA9IChtcykgPT4gbmV3IFByb21pc2UoKHIp
ID0+IHNldFRpbWVvdXQociwgbXMpKQptYWluKCkK
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

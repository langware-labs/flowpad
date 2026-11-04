# End-to-end checks of the Windows uninstaller engine (FLOWPAD-2250): `flow-rs uninstall`,
# `deferred-cleanup` and `app-running`, against a SCRATCH tree, never a real installation.
#
# Needs a DEBUG build of flow-rs: only debug builds honour FLOWRS_TEST_LAYOUT_ROOT (every user
# folder is redirected into the scratch tree) and FLOWRS_TEST_ALLOW_UNSIGNED (the unsigned debug
# helper may schedule itself). Release builds have neither switch.
#
#   cargo build --manifest-path flow_sdk\rust\Cargo.toml --bin flow-rs
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win_uninstall_e2e.ps1
#
# The deferred-cleanup scenarios need the Windows Credential Manager, which a network logon
# (ssh) or a service session does not have; they are reported as SKIP there, never as PASS.
# Run the script in a normal desktop session to cover them. Exit code = number of failures.
#
# Scenarios: desktop-exclusive engine (complete), shared engine (kept), locked file (scheduled,
# then finished by deferred-cleanup), tampered cleanup state (refused), planted junction (not
# followed, reported), opt-in data deletion, opt-in never reaches a CLI-used instance,
# classify-only changes nothing, app-running matches only this installation's Flowpad.exe.
param(
  [string]$FlowRs = (Join-Path $PSScriptRoot '..\flow_sdk\rust\target\debug\flow-rs.exe'),
  [string]$Root = (Join-Path $env:TEMP 'flowpad-uninstall-e2e')
)
$ErrorActionPreference = 'Stop'
$FlowRs = (Resolve-Path $FlowRs).Path

Add-Type @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class FileIdentity {
  // FILETIME fields are 4-byte aligned in BY_HANDLE_FILE_INFORMATION: Pack = 4, or every field shifts.
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct Info { public uint Attr; public long C, A, W; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string p, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
  // What the desktop records (Node's statSync dev/ino) and flow-rs compares: volume serial + file index.
  // Holds a folder open with NO sharing: anything else that opens it meanwhile gets a sharing violation.
  public static SafeFileHandle HoldDir(string path) {
    var h = CreateFile(path, 0x1, 0, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h.IsInvalid) throw new Exception("cannot hold " + path);
    return h;
  }
  public static string[] Of(string path) {
    using (var h = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero)) {
      Info i; if (h.IsInvalid || !GetFileInformationByHandle(h, out i)) throw new Exception("cannot read the identity of " + path);
      return new[] { i.Volume.ToString(), (((ulong)i.IndexHigh << 32) | i.IndexLow).ToString() };
    }
  }
}
'@

$script:fails = 0
$script:skips = 0
$holders = @()
function Check($cond, $msg) { if ($cond) { Write-Host "  PASS $msg" } else { Write-Host "  FAIL $msg"; $script:fails++ } }
function Skip($msg) { Write-Host "  SKIP $msg"; $script:skips++ }
function W($p, $t = 'x') { New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null; [IO.File]::WriteAllText($p, [string]$t) }
function Remove-Tree($p) { if (Test-Path $p) { cmd /c "rmdir /s /q `"$p`"" | Out-Null } }

# A complete, realistic layout: an engine the desktop installed (record + receipt + shims), its
# repaired runtime (marked), desktop state, a desktop-managed instance, launcher and updater
# leftovers, temp files, and things that are NOT FlowPad's (uv itself, another uv tool, a user's
# notes, an unrelated temp file, a canary outside every FlowPad folder).
function New-Layout($name) {
  $r = Join-Path $Root $name
  Remove-Tree $r
  $p = "$r\profile"; $l = "$r\local"; $ro = "$r\roaming"
  $venv = "$ro\uv\tools\flowpad"; $bin = "$p\.local\bin"; $rt = "$l\Flowpad\runtime"
  W "$venv\Lib\site-packages\flow_sdk\__init__.py"; W "$venv\Scripts\python.exe"
  W "$venv\pyvenv.cfg" "home = $rt\python-3.11.9`r`n"
  $b = $bin.Replace('\', '\\')
  [IO.File]::WriteAllText("$venv\uv-receipt.toml", "[tool]`r`nrequirements = [{ name = `"flowpad`", specifier = `"==0.2.60`" }]`r`nentrypoints = [`r`n    { name = `"flow`", install-path = `"$b\\flow.exe`", from = `"flowpad`" },`r`n    { name = `"flow-sdk-mcp`", install-path = `"$b\\flow-sdk-mcp.exe`", from = `"flowpad`" },`r`n]`r`n")
  W "$bin\flow.exe"; W "$bin\flow-sdk-mcp.exe"; W "$bin\uv.exe" 'uv'; W "$bin\uvx.exe" 'uvx'
  W "$ro\uv\tools\flowpad.corrupt-1\x"; W "$ro\uv\tools\other-tool\pyvenv.cfg" "home = C:\Python311`r`n"
  $id = [FileIdentity]::Of($venv)
  $sha = (Get-FileHash "$venv\uv-receipt.toml" -Algorithm SHA256).Hash.ToLower()
  W "$l\Flowpad\engine-ownership.json" (@{ schema = 1; origin = 'desktop'; venv = $venv; venvVolume = $id[0]; venvFileId = $id[1]; receiptSha256 = $sha; desktopVersion = '0.2.60'; installedAt = 'T' } | ConvertTo-Json)
  $tok = 'tok-' + [guid]::NewGuid().ToString('N')
  W "$rt\python-3.11.9\python.exe"; W "$rt\python-3.11.9\.flowpad-owned" (@{ owner = 'flowpad-desktop'; token = $tok } | ConvertTo-Json)
  W "$rt\downloads\python.3.11.9.nupkg.zip"; W "$rt\downloads\.flowpad-owned" (@{ owner = 'flowpad-desktop'; token = $tok } | ConvertTo-Json)
  W "$p\.flow\desktop-runtime.json" (@{ python = "$rt\python-3.11.9\python.exe"; version = '3.11.9'; runtimeOwnership = @{ token = $tok; dirs = @('python-3.11.9', 'downloads') } } | ConvertTo-Json)
  W "$p\.flow\desktop-install-in-progress.json" '{}'
  W "$p\.flow\instances\prod\.desktop_managed" ''; W "$p\.flow\instances\prod\flowpad.db" 'db'
  W "$p\.flow\instances\prod\server.json" '{"port":59999,"server_pid":4,"server_create_time":1.0,"launched_by":"desktop"}'
  W "$p\.flow\global\cli-stamp-since" '{"version":"0.2.60","since":1.0,"preexisting":[]}'; W "$p\.flow\logs\main_desktop\a.log"
  W "$l\Flowpad\bootstrap\Flowpad-0.2.60-Setup.exe"; W "$l\Flowpad\bootstrap\flowpad-install.log"; W "$l\Flowpad\bootstrap\user-notes.txt" 'mine'
  W "$l\flowpad-updater\installer.exe"; W "$l\flowpad-updater\pending\update-info.json" '{"fileName":"Flowpad-Setup-0.2.61.exe"}'; W "$l\flowpad-updater\pending\Flowpad-Setup-0.2.61.exe"
  W "$r\temp\flowpad-uv-123\x"; W "$r\temp\flowpad-support-1.zip"; W "$r\temp\someone-else.txt" 'keep'
  W "$ro\Flowpad\Cache\x"; W "$r\canary\secret.txt" 'CANARY'
  W "$r\install\Flowpad.exe"
  return $r
}

function Invoke-Uninstall($r, [string[]]$extra) {
  $env:FLOWRS_TEST_LAYOUT_ROOT = $r; $env:FLOWRS_TEST_ALLOW_UNSIGNED = '1'
  try {
    & $FlowRs uninstall --install-dir "$r\install" --log "$r\uninstall.log" --result "$r\result.json" @extra | Out-Null
    return $LASTEXITCODE
  } finally { Remove-Item Env:FLOWRS_TEST_LAYOUT_ROOT, Env:FLOWRS_TEST_ALLOW_UNSIGNED -ErrorAction SilentlyContinue }
}

function Invoke-Deferred($r) {
  $env:FLOWRS_TEST_LAYOUT_ROOT = $r
  try {
    & "$r\local\Flowpad\fc\flow-rs.exe" deferred-cleanup --trigger manual --log "$r\deferred.log" | Out-Null
    return $LASTEXITCODE
  } finally { Remove-Item Env:FLOWRS_TEST_LAYOUT_ROOT -ErrorAction SilentlyContinue }
}

# Waits for a condition instead of a fixed time; $false if it never holds within the ceiling.
function Wait-Until([scriptblock]$cond, [int]$secs = 30) {
  $end = (Get-Date).AddSeconds($secs)
  while (-not (& $cond)) { if ((Get-Date) -gt $end) { return $false }; Start-Sleep -Milliseconds 100 }
  return $true
}

# True only while another process holds the file (a sharing violation). A missing path, a folder,
# or any other error is "not held": never a crash of the whole run.
function Test-Held($path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  try { $x = [IO.File]::Open($path, 'Open', 'ReadWrite', 'ReadWrite,Delete'); $x.Close(); return $false }
  catch {
    $ex = $_.Exception; if ($ex.InnerException) { $ex = $ex.InnerException }  # a .NET call's error comes wrapped
    return (($ex.HResult -band 0xFFFF) -eq 32)  # ERROR_SHARING_VIOLATION
  }
}

# Holds a file open WITHOUT share-delete, as an editor or an antivirus scan would.
function Lock-File($path) {
  $h = Start-Process powershell -ArgumentList '-NoProfile', '-Command', "`$f=[IO.File]::Open('$path','Open','Read','Read'); Start-Sleep 120" -PassThru -WindowStyle Hidden
  $script:holders += $h
  $ok = Wait-Until { Test-Held $path } 10
  Check $ok "the test holds $path"
  return $h
}

# Ends the holders and waits until they are gone (their handles closed).
function Release($procs) {
  Stop-Process -Id ($procs | ForEach-Object { $_.Id }) -Force -ErrorAction SilentlyContinue
  $procs | ForEach-Object { $_.WaitForExit(30000) | Out-Null }
}

function Result($r) { Get-Content "$r\result.txt" -Raw }
$runOnce = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'

# A native command's stderr is an error under 'Stop' in Windows PowerShell 5.1; these calls may
# fail by design, so run them with errors relaxed and judge them by their exit code.
function Invoke-Quiet([scriptblock]$cmd) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $cmd 2>&1 | Out-Null; return $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
}

# The deferred cleanup keeps its key in the Credential Manager: probe it the way flow-rs uses it.
$credentials = ((Invoke-Quiet { & $FlowRs set_key Flowpad.cleanup.debug e2e-probe x }) -eq 0)
Invoke-Quiet { & $FlowRs delete_key Flowpad.cleanup.debug e2e-probe } | Out-Null

try {
  Write-Host '== desktop-exclusive engine, defaults: complete'
  $r = New-Layout 'exclusive'
  $code = Invoke-Uninstall $r @()
  Check ($code -eq 0) "exit 0 (complete), got $code"
  Check (-not (Test-Path "$r\roaming\uv\tools\flowpad")) 'engine venv removed'
  Check (-not (Test-Path "$r\profile\.local\bin\flow.exe") -and -not (Test-Path "$r\profile\.local\bin\flow-sdk-mcp.exe")) "FlowPad's commands removed"
  Check ((Test-Path "$r\profile\.local\bin\uv.exe") -and (Test-Path "$r\profile\.local\bin\uvx.exe")) 'uv and uvx untouched'
  Check (Test-Path "$r\roaming\uv\tools\other-tool\pyvenv.cfg") 'another uv tool untouched'
  Check (-not (Test-Path "$r\roaming\uv\tools\flowpad.corrupt-1")) 'set-aside corrupt engine removed'
  Check (-not (Test-Path "$r\local\Flowpad\engine-ownership.json")) 'ownership record removed'
  Check (-not (Test-Path "$r\local\Flowpad\runtime")) 'repaired runtime removed'
  Check (-not (Test-Path "$r\profile\.flow\desktop-runtime.json")) 'runtime record removed with its runtime'
  Check (-not (Test-Path "$r\profile\.flow\desktop-install-in-progress.json")) 'install marker removed'
  Check ((Test-Path "$r\local\Flowpad\bootstrap\user-notes.txt") -and -not (Test-Path "$r\local\Flowpad\bootstrap\Flowpad-0.2.60-Setup.exe")) "launcher downloads removed, the user's file kept"
  Check (-not (Test-Path "$r\local\flowpad-updater")) 'updater cache removed'
  Check ((Test-Path "$r\temp\someone-else.txt") -and -not (Test-Path "$r\temp\flowpad-uv-123") -and -not (Test-Path "$r\temp\flowpad-support-1.zip")) 'FlowPad temp files removed, others kept'
  Check ((Test-Path "$r\roaming\Flowpad\Cache\x") -and (Test-Path "$r\profile\.flow\instances\prod\flowpad.db") -and (Test-Path "$r\profile\.flow\global")) 'user data kept by default'
  Check ((Get-Content "$r\canary\secret.txt") -eq 'CANARY') 'canary intact'
  Check ((Result $r) -match '^FlowPad was removed\.') 'summary says complete'
  $left = (Get-ChildItem $r -Recurse -Force | Where-Object { $_.Name -notlike 'result.*' -and $_.Name -ne 'uninstall.log' } | Measure-Object).Count
  $code = Invoke-Uninstall $r @()
  Check ($code -eq 0) "a second run over the same machine is a clean no-op (exit $code)"
  Check (((Get-ChildItem $r -Recurse -Force | Where-Object { $_.Name -notlike 'result.*' -and $_.Name -ne 'uninstall.log' } | Measure-Object).Count) -eq $left) 'and removes nothing more'

  Write-Host '== an interrupted repair left the previous engine set aside: kept and reported'
  $r = New-Layout 'pre-repair'
  W "$r\roaming\uv\tools\flowpad.pre-repair\x" 'previous engine'
  W "$r\roaming\uv\tools\flowpad.pre-repair\pyvenv.cfg" "home = $r\local\Flowpad\runtime\python-3.11.9`r`n"
  $code = Invoke-Uninstall $r @()
  Check ($code -eq 20) "partial (exit 20), got $code"
  Check (-not (Test-Path "$r\roaming\uv\tools\flowpad")) 'the desktop-installed engine is still removed'
  Check (Test-Path "$r\roaming\uv\tools\flowpad.pre-repair\x") 'the set-aside copy is kept'
  Check (Test-Path "$r\local\Flowpad\runtime\python-3.11.9\python.exe") 'and the runtime it runs on is kept with it'
  Check ((Result $r) -match 'interrupted repair') 'and reported'

  Write-Host '== a set-aside engine whose record proves the desktop made it: removed'
  $r = New-Layout 'pre-repair-ours'
  $aside = "$r\roaming\uv\tools\flowpad.pre-repair"
  W "$aside\uv-receipt.toml" 'receipt of the previous engine'
  $aid = [FileIdentity]::Of($aside)
  $asha = (Get-FileHash "$aside\uv-receipt.toml" -Algorithm SHA256).Hash.ToLower()
  W "$r\local\Flowpad\engine-ownership.pre-repair.json" (@{ schema = 1; origin = 'desktop'; venv = "$r\roaming\uv\tools\flowpad"; venvVolume = $aid[0]; venvFileId = $aid[1]; receiptSha256 = $asha; desktopVersion = '0.2.59'; installedAt = 'T' } | ConvertTo-Json)
  $code = Invoke-Uninstall $r @()
  Check ($code -eq 0) "exit 0 (complete), got $code"
  Check (-not (Test-Path $aside)) 'the set-aside copy is removed'
  Check (-not (Test-Path "$r\local\Flowpad\engine-ownership.pre-repair.json")) 'with its record'

  Write-Host '== no engine, but a repair was interrupted: the proven set-aside copy goes, then its runtime'
  $r = New-Layout 'pre-repair-no-engine'
  Remove-Tree "$r\roaming\uv\tools\flowpad"; Remove-Item "$r\local\Flowpad\engine-ownership.json"
  $aside = "$r\roaming\uv\tools\flowpad.pre-repair"
  W "$aside\uv-receipt.toml" 'receipt of the previous engine'
  W "$aside\pyvenv.cfg" "home = $r\local\Flowpad\runtime\python-3.11.9`r`n"
  $aid = [FileIdentity]::Of($aside)
  $asha = (Get-FileHash "$aside\uv-receipt.toml" -Algorithm SHA256).Hash.ToLower()
  W "$r\local\Flowpad\engine-ownership.pre-repair.json" (@{ schema = 1; origin = 'desktop'; venv = "$r\roaming\uv\tools\flowpad"; venvVolume = $aid[0]; venvFileId = $aid[1]; receiptSha256 = $asha; desktopVersion = '0.2.59'; installedAt = 'T' } | ConvertTo-Json)
  $code = Invoke-Uninstall $r @()
  Check ($code -eq 0) "exit 0 (complete), got $code"
  Check (-not (Test-Path $aside)) 'the set-aside copy is removed'
  Check (-not (Test-Path "$r\local\Flowpad\runtime")) 'and the runtime, which nothing runs on any more'

  Write-Host '== an instance that predates CLI-use stamping: the engine is kept unless the user opts in'
  $r = New-Layout 'predates'
  W "$r\profile\.flow\global\cli-stamp-since" '{"version":"0.2.60","since":1.0,"preexisting":["prod"]}'
  $code = Invoke-Uninstall $r @()
  Check ($code -eq 20) "partial (exit 20), got $code"
  Check (Test-Path "$r\roaming\uv\tools\flowpad\uv-receipt.toml") 'engine kept: the command line may have used it before stamping'
  $code = Invoke-Uninstall $r @('--remove-engine')
  Check (-not (Test-Path "$r\roaming\uv\tools\flowpad")) 'removed when the user opts in'

  Write-Host '== an instance the desktop does not manage shares the engine: kept'
  $r = New-Layout 'shared'
  W "$r\profile\.flow\instances\oss\config.json"
  $code = Invoke-Uninstall $r @()
  Check ($code -eq 20) "exit 20 (partial), got $code"
  Check (Test-Path "$r\roaming\uv\tools\flowpad\uv-receipt.toml") 'shared engine kept'
  Check (Test-Path "$r\local\Flowpad\runtime\python-3.11.9\python.exe") 'its runtime kept'
  Check ((Result $r) -match 'not managed by the desktop') 'the reason is reported'

  Write-Host '== a file in use: scheduled, then finished by deferred-cleanup'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session (network logon or service); run in a desktop session'
  } else {
    $r = New-Layout 'locked'
    # prod's key, under the debug builds' own name (never the machine's real one)
    Invoke-Quiet { & $FlowRs set_key Flowpad.ai.sod_key.debug prod.flow-rs e2e } | Out-Null
    $h = Lock-File "$r\roaming\uv\tools\flowpad\Lib\site-packages\flow_sdk\__init__.py"
    $hp = Lock-File "$r\profile\.flow\instances\prod\flowpad.db"
    $code = Invoke-Uninstall $r @('--delete-app-data', '--delete-instance-data')
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Check (Test-Path "$r\roaming\uv\tools\flowpad\uv-receipt.toml") 'receipt (the ownership proof) kept while anything is left'
    Check (Test-Path "$r\local\Flowpad\runtime\python-3.11.9\python.exe") 'runtime waits behind the engine'
    Check (Test-Path "$r\profile\.flow\desktop-runtime.json") 'app-data deletion keeps the runtime record the deferred run needs'
    Check (Test-Path "$r\profile\.flow\instances\prod\.desktop_managed") 'prod in use: its marker (the proof) kept for the deferred run'
    Check ((Invoke-Quiet { & $FlowRs get_key Flowpad.ai.sod_key.debug prod.flow-rs }) -eq 0) "prod's key kept while its folder remains"
    $cmd = (Get-ItemProperty $runOnce -ErrorAction SilentlyContinue).FlowpadCleanupTest
    Check ($cmd -and $cmd.Contains("$r\local\Flowpad\fc\flow-rs.exe")) 'RunOnce (test value) starts the helper copy'
    Check ((Result $r) -match 'will be removed the next time you sign in') 'summary says sign out to finish'
    Release @($h, $hp)
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 0) "deferred-cleanup exit 0, got $dcode"
    Check (-not (Test-Path "$r\roaming\uv\tools\flowpad")) 'engine gone after the deferred run'
    Check (-not (Test-Path "$r\profile\.flow\instances\prod")) 'prod gone after the deferred run'
    Check (-not (Test-Path "$r\profile\.flow\global")) 'and the shared global/ with it: no instance is left'
    Check ((Invoke-Quiet { & $FlowRs get_key Flowpad.ai.sod_key.debug prod.flow-rs }) -ne 0) "and its key with it"
    Check (-not (Test-Path "$r\local\Flowpad\runtime")) 'runtime gone after the engine'
    Check (-not (Test-Path "$r\profile\.flow\desktop-runtime.json")) 'runtime record gone'
    Check (-not (Test-Path "$r\local\Flowpad\engine-ownership.json")) 'ownership record gone'
    Check (Wait-Until { -not (Test-Path "$r\local\Flowpad\fc") }) 'the helper removed itself'
    Check (-not (Get-ItemProperty $runOnce -ErrorAction SilentlyContinue).FlowpadCleanupTest) 'RunOnce test value gone'
  }

  Write-Host '== a set-aside engine in use: deferred with its runtime, then both removed'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'pre-repair-locked'
    $aside = "$r\roaming\uv\tools\flowpad.pre-repair"
    W "$aside\uv-receipt.toml" 'receipt of the previous engine'
    W "$aside\pyvenv.cfg" "home = $r\local\Flowpad\runtime\python-3.11.9`r`n"
    W "$aside\Lib\held.py" 'x'
    $aid = [FileIdentity]::Of($aside)
    $asha = (Get-FileHash "$aside\uv-receipt.toml" -Algorithm SHA256).Hash.ToLower()
    W "$r\local\Flowpad\engine-ownership.pre-repair.json" (@{ schema = 1; origin = 'desktop'; venv = "$r\roaming\uv\tools\flowpad"; venvVolume = $aid[0]; venvFileId = $aid[1]; receiptSha256 = $asha; desktopVersion = '0.2.59'; installedAt = 'T' } | ConvertTo-Json)
    $h = Lock-File "$aside\Lib\held.py"
    $code = Invoke-Uninstall $r @()
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Check (Test-Path "$aside\uv-receipt.toml") 'the set-aside copy waits, its receipt (the proof) kept'
    Check (Test-Path "$r\local\Flowpad\runtime\python-3.11.9\python.exe") 'its runtime waits behind it'
    Release @($h)
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 0) "deferred-cleanup exit 0, got $dcode"
    Check (-not (Test-Path $aside)) 'the set-aside copy gone after the deferred run'
    Check (-not (Test-Path "$r\local\Flowpad\runtime")) 'and the runtime after it'
    Check (-not (Test-Path "$r\local\Flowpad\engine-ownership.pre-repair.json")) 'and its record'
    Check (Wait-Until { -not (Test-Path "$r\local\Flowpad\fc") }) 'the helper removed itself'
    Check (-not (Get-ItemProperty $runOnce -ErrorAction SilentlyContinue).FlowpadCleanupTest) 'RunOnce test value gone'
  }

  Write-Host '== a deferred set-aside copy no longer proven at the next run: kept with its runtime, the cleanup finishes'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'pre-repair-unproven'
    $aside = "$r\roaming\uv\tools\flowpad.pre-repair"
    W "$aside\uv-receipt.toml" 'receipt of the previous engine'
    W "$aside\pyvenv.cfg" "home = $r\local\Flowpad\runtime\python-3.11.9`r`n"
    W "$aside\Lib\held.py" 'x'
    $aid = [FileIdentity]::Of($aside)
    $asha = (Get-FileHash "$aside\uv-receipt.toml" -Algorithm SHA256).Hash.ToLower()
    W "$r\local\Flowpad\engine-ownership.pre-repair.json" (@{ schema = 1; origin = 'desktop'; venv = "$r\roaming\uv\tools\flowpad"; venvVolume = $aid[0]; venvFileId = $aid[1]; receiptSha256 = $asha; desktopVersion = '0.2.59'; installedAt = 'T' } | ConvertTo-Json)
    # pyvenv.cfg is the file held: what survives the first attempt still runs on the runtime
    $h = Lock-File "$aside\pyvenv.cfg"
    $code = Invoke-Uninstall $r @()
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Release @($h)
    W "$aside\uv-receipt.toml" 'changed since: no longer the recorded copy'
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 0) "deferred-cleanup exit 0 (nothing left pending), got $dcode"
    Check (Test-Path "$aside\uv-receipt.toml") 'the copy, no longer proven, is kept'
    Check (Test-Path "$r\local\Flowpad\runtime\python-3.11.9\python.exe") 'and so is the runtime it runs on'
    Check (Wait-Until { -not (Test-Path "$r\local\Flowpad\fc") }) 'the cleanup finished: the helper removed itself'
    Check (-not (Get-ItemProperty $runOnce -ErrorAction SilentlyContinue).FlowpadCleanupTest) 'nothing left scheduled'
  }

  Write-Host '== the deferred run keeps a runtime a kept set-aside engine runs on, and finishes'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'deferred-kept'
    $h = Lock-File "$r\roaming\uv\tools\flowpad\Lib\site-packages\flow_sdk\__init__.py"
    $code = Invoke-Uninstall $r @()
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Release @($h)
    # an engine copy nothing proves is FlowPad's appears on the runtime before the deferred run
    W "$r\roaming\uv\tools\flowpad.pre-repair\pyvenv.cfg" "home = $r\local\Flowpad\runtime\python-3.11.9`r`n"
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 0) "deferred-cleanup exit 0 (nothing left pending), got $dcode"
    Check (-not (Test-Path "$r\roaming\uv\tools\flowpad")) 'the engine is gone'
    Check (Test-Path "$r\local\Flowpad\runtime\python-3.11.9\python.exe") 'the runtime the kept copy runs on is kept'
    Check (Wait-Until { -not (Test-Path "$r\local\Flowpad\fc") }) 'the cleanup finished: the helper removed itself'
    Check (-not (Get-ItemProperty $runOnce -ErrorAction SilentlyContinue).FlowpadCleanupTest) 'nothing left scheduled'
  }

  Write-Host '== a folder unreadable at the deferred run (held, scanned) stays pending and is retried'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'deferred-unreadable'
    $venv = "$r\roaming\uv\tools\flowpad"
    $h = Lock-File "$venv\Lib\site-packages\flow_sdk\__init__.py"
    $code = Invoke-Uninstall $r @()
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Release @($h)
    $held = [FileIdentity]::HoldDir($venv)
    try { $dcode = Invoke-Deferred $r } finally { $held.Dispose() }
    Check ($dcode -eq 20) "while the folder cannot be opened: still pending (exit 20), got $dcode"
    Check (Test-Path "$venv\uv-receipt.toml") 'nothing of it removed'
    Check (Test-Path "$r\local\Flowpad\fc\state.json") 'the pending state is kept for the next run'
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 0) "once it can be opened: finished (exit 0), got $dcode"
    Check (-not (Test-Path $venv)) 'the engine is removed'
    Check (Wait-Until { -not (Test-Path "$r\local\Flowpad\fc") }) 'the helper removed itself'
  }

  Write-Host '== an engine no longer proven at the deferred run: kept with its runtime, the cleanup finishes'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'deferred-engine-unproven'
    $venv = "$r\roaming\uv\tools\flowpad"
    $h = Lock-File "$venv\uv-receipt.toml"
    $code = Invoke-Uninstall $r @()
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Release @($h)
    [IO.File]::WriteAllText("$venv\uv-receipt.toml", 'reinstalled by someone else since')
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 0) "deferred-cleanup exit 0 (nothing left pending), got $dcode"
    Check (Test-Path "$venv\uv-receipt.toml") 'the engine, no longer proven, is kept'
    Check (Test-Path "$r\local\Flowpad\runtime\python-3.11.9\python.exe") 'and so is the runtime it runs on'
    Check (Wait-Until { -not (Test-Path "$r\local\Flowpad\fc") }) 'the cleanup finished: the helper removed itself'
  }

  Write-Host '== only a quarantined copy pending, the engine reinstalled since: its processes are left alone'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'corrupt-pending-reinstalled'
    $copy = "$r\roaming\uv\tools\flowpad.corrupt-1"
    $h = Lock-File "$copy\x"
    $code = Invoke-Uninstall $r @()
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Check (-not (Test-Path "$r\roaming\uv\tools\flowpad")) 'the engine itself was removed'
    Release @($h)
    # a new engine is installed and running before the deferred run
    New-Item -ItemType Directory -Force "$r\roaming\uv\tools\flowpad\Scripts" | Out-Null
    Copy-Item "$env:SystemRoot\System32\PING.EXE" "$r\roaming\uv\tools\flowpad\Scripts\flow.exe" -Force
    $p = Start-Process "$r\roaming\uv\tools\flowpad\Scripts\flow.exe" -ArgumentList '-n', '60', '127.0.0.1' -PassThru -WindowStyle Hidden
    $script:holders += $p
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 0) "deferred-cleanup exit 0, got $dcode"
    Check (-not (Test-Path $copy)) 'the quarantined copy is removed'
    Check (-not $p.HasExited) 'a process of the reinstalled engine is left running'
    Check (Test-Path "$r\roaming\uv\tools\flowpad\Scripts\flow.exe") 'and the reinstalled engine is untouched'
    Release @($p)
  }

  Write-Host '== a pending folder its ACL now blocks: kept, the cleanup finishes'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'deferred-acl'
    $venv = "$r\roaming\uv\tools\flowpad"
    $h = Lock-File "$venv\Lib\site-packages\flow_sdk\__init__.py"
    $code = Invoke-Uninstall $r @()
    Check ($code -eq 10) "exit 10 (restart required), got $code"
    Release @($h)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    icacls $venv /deny "${me}:(RD)" | Out-Null
    try { $dcode = Invoke-Deferred $r } finally { icacls $venv /remove:d $me | Out-Null }
    Check ($dcode -eq 0) "deferred-cleanup exit 0 (nothing left pending), got $dcode"
    Check (Test-Path "$venv\uv-receipt.toml") 'the folder it cannot open is kept, nothing deleted'
    Check (Wait-Until { -not (Test-Path "$r\local\Flowpad\fc") }) 'the cleanup finished: the helper removed itself'
  }

  Write-Host '== a tampered cleanup state: refused, nothing deleted'
  if (-not $credentials) {
    Skip 'the Credential Manager is not available in this session'
  } else {
    $r = New-Layout 'tampered'
    $h = Lock-File "$r\roaming\uv\tools\flowpad\Lib\site-packages\flow_sdk\__init__.py"
    Invoke-Uninstall $r @() | Out-Null
    Release @($h)
    $state = "$r\local\Flowpad\fc\state.json"
    Set-Content $state ((Get-Content $state -Raw) -replace '"fileId": (\d+)', '"fileId": 1') -NoNewline
    $dcode = Invoke-Deferred $r
    Check ($dcode -eq 20) "refused (exit 20), got $dcode"
    Check (Test-Path "$r\roaming\uv\tools\flowpad\uv-receipt.toml") 'nothing deleted'
    Check ((Get-Content "$r\local\Flowpad\fc\status.log" -Raw) -match 'refused: the state file was modified') 'status says why'
  }

  Write-Host '== a junction planted where the runtime was: not followed, reported'
  $r = New-Layout 'junction'
  Remove-Tree "$r\local\Flowpad\runtime\python-3.11.9"
  cmd /c "mklink /J `"$r\local\Flowpad\runtime\python-3.11.9`" `"$r\canary`"" | Out-Null
  $code = Invoke-Uninstall $r @()
  Check ((Get-Content "$r\canary\secret.txt") -eq 'CANARY') 'the target behind the junction is intact'
  Check ($code -eq 20) "partial (exit 20), got $code"
  Check ((Result $r) -match 'junction or symbolic link') 'the junction is reported, not silently skipped'

  Write-Host '== opt-in: app data and instance data'
  $r = New-Layout 'optin'
  $code = Invoke-Uninstall $r @('--delete-app-data', '--delete-instance-data')
  Check ($code -eq 0) "exit 0, got $code"
  Check (-not (Test-Path "$r\roaming\Flowpad")) 'app data removed'
  Check (-not (Test-Path "$r\profile\.flow\instances")) 'the only instance removed'
  Check (-not (Test-Path "$r\profile\.flow\global")) 'shared state removed once no instance is left'
  Check ((Get-Content "$r\canary\secret.txt") -eq 'CANARY') 'canary intact'

  Write-Host '== opt-in never reaches an instance the command line also uses'
  $r = New-Layout 'cliused'
  W "$r\profile\.flow\instances\prod\.cli_used" '{}'
  Invoke-Uninstall $r @('--delete-instance-data', '--remove-engine') | Out-Null
  Check (Test-Path "$r\profile\.flow\instances\prod\flowpad.db") 'CLI-used instance data kept despite the flag'
  Check (-not (Test-Path "$r\roaming\uv\tools\flowpad")) 'engine removed with consent (desktop-made, CLI-used)'

  Write-Host '== classify-only changes nothing'
  $r = New-Layout 'classify'
  $before = (Get-ChildItem $r -Recurse -Force | Measure-Object).Count
  $env:FLOWRS_TEST_LAYOUT_ROOT = $r
  & $FlowRs uninstall --install-dir "$r\install" --classify-only --ini "$r\page.ini" | Out-Null
  Remove-Item Env:FLOWRS_TEST_LAYOUT_ROOT
  $after = (Get-ChildItem $r -Recurse -Force | Where-Object { $_.Name -ne 'page.ini' } | Measure-Object).Count
  Check ($before -eq $after) "nothing changed ($before vs $after items)"
  $ini = Get-Content "$r\page.ini"
  Check (($ini -contains 'category=desktop-exclusive') -and ($ini -contains 'remove=1')) 'page: engine desktop-exclusive, removed'

  Write-Host "== app-running: only this installation's Flowpad.exe"
  $a = Join-Path $Root 'app\install'; $b = Join-Path $Root 'app\other'
  New-Item -ItemType Directory -Force $a, $b | Out-Null
  Copy-Item "$env:SystemRoot\System32\PING.EXE" "$a\Flowpad.exe" -Force
  Copy-Item "$env:SystemRoot\System32\PING.EXE" "$b\Flowpad.exe" -Force
  & $FlowRs app-running --install-dir $a; Check ($LASTEXITCODE -eq 0) "not running: exit 0 (got $LASTEXITCODE)"
  $pa = Start-Process "$a\Flowpad.exe" -ArgumentList '-n', '60', '127.0.0.1' -PassThru -WindowStyle Hidden
  $pb = Start-Process "$b\Flowpad.exe" -ArgumentList '-n', '60', '127.0.0.1' -PassThru -WindowStyle Hidden
  $script:holders += $pa, $pb
  Wait-Until { @(Get-Process -Id $pa.Id, $pb.Id -ErrorAction SilentlyContinue).Count -eq 2 } | Out-Null
  & $FlowRs app-running --install-dir $a; Check ($LASTEXITCODE -eq 1) "running: exit 1 (got $LASTEXITCODE)"
  & $FlowRs app-running --install-dir $a --stop; Check ($LASTEXITCODE -eq 0) "--stop: exit 0 (got $LASTEXITCODE)"
  Check (Wait-Until { $pa.HasExited } 10) 'the app of this installation was stopped'
  Check (-not $pb.HasExited) 'a Flowpad.exe from another folder is untouched'
} finally {
  $alive = @($holders | Where-Object { $_ -and -not $_.HasExited })
  if ($alive.Count) { Release $alive }
  Remove-ItemProperty $runOnce -Name FlowpadCleanupTest -ErrorAction SilentlyContinue
  Invoke-Quiet { & $FlowRs delete_key Flowpad.cleanup.debug state } | Out-Null
  Remove-Tree $Root
}

Write-Host ''
if ($script:fails -eq 0) { Write-Host "ALL CHECKS PASSED ($($script:skips) skipped)" } else { Write-Host "$($script:fails) CHECK(S) FAILED ($($script:skips) skipped)" }
exit $script:fails

@echo off
:: Reset the Windows state for the flowpad:// custom URL scheme.
::
:: Windows equivalent of scripts/clean_flowpad_protocol.sh.
::
:: Use this when you want a clean "FlowPad is not installed" baseline OR
:: when a stale registry entry is causing the OS to launch the wrong FlowPad
:: bundle (or a dev-mode Electron without the script-path argument, which
:: makes deep-link cold-start lose the URL).
::
:: What this script does:
::   1. Deletes the user-level HKCU\Software\Classes\flowpad registration.
::   2. Tries to delete the machine-level HKLM\Software\Classes\flowpad
::      registration. Requires "Run as administrator" — silently skipped
::      otherwise.
::   3. Prints whatever flowpad:// handler entries remain.
::
:: What this script does NOT do:
::   * Quit a running FlowPad / Electron. If a dev Electron is running it
::     will re-register itself on its next setAsDefaultProtocolClient call.
::     Quit it BEFORE running this script for a true clean state.
::   * Uninstall the production FlowPad app from Program Files.
::
:: Usage:
::   scripts\clean_flowpad_protocol.cmd
::
:: After running, also clear the browser-side cache:
::   localStorage.removeItem('flowpad-app-installed-at')

setlocal

echo == 1. Removing user-level flowpad:// registration (HKCU) =============
reg delete "HKCU\Software\Classes\flowpad" /f >nul 2>&1
if errorlevel 1 (
  echo    no HKCU entry found
) else (
  echo    removed HKCU\Software\Classes\flowpad
)

echo.
echo == 2. Trying to remove machine-level registration (HKLM) =============
echo    (needs "Run as administrator" — skipped silently if not elevated)
reg delete "HKLM\Software\Classes\flowpad" /f >nul 2>&1
if errorlevel 1 (
  echo    no HKLM entry found / not elevated
) else (
  echo    removed HKLM\Software\Classes\flowpad
)

echo.
echo == 3. Verifying — any remaining flowpad:// handlers? =================
reg query "HKCU\Software\Classes\flowpad" >nul 2>&1
if not errorlevel 1 (
  echo    STILL PRESENT: HKCU\Software\Classes\flowpad
  reg query "HKCU\Software\Classes\flowpad\shell\open\command"
)
reg query "HKLM\Software\Classes\flowpad" >nul 2>&1
if not errorlevel 1 (
  echo    STILL PRESENT: HKLM\Software\Classes\flowpad
  reg query "HKLM\Software\Classes\flowpad\shell\open\command"
)
reg query "HKCR\flowpad" >nul 2>&1
if not errorlevel 1 (
  echo    NOTE: HKCR\flowpad still resolves (merged view of HKLM+HKCU).
)

echo.
echo Done.
echo.
echo Next steps:
echo   1. Start your dev Electron once (npm start from desk-1845/electron).
echo      It re-registers itself by calling app.setAsDefaultProtocolClient.
echo.
echo   2. Verify the new HKCU entry includes BOTH electron.exe AND the
echo      main.js path (script-path argument required in dev mode):
echo        reg query "HKCU\Software\Classes\flowpad\shell\open\command"
echo      Expected (default) value:
echo        "C:\...\electron.exe" "C:\...\desk-1845\electron\main.js" "%%1"
echo.
echo   3. Quit Electron. Click "Open in FlowPad" in the browser.
echo.
echo   4. Tail the latest log under:
echo        %USERPROFILE%\.flow\logs\main_desktop\
echo      Expect a "[deep-link] picked up from process.argv:" line, then
echo      "Loading UI from http://localhost:9007/auth/login_callback?..."

endlocal

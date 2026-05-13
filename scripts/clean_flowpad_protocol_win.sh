#!/usr/bin/env bash
# Reset the Windows state for the flowpad:// custom URL scheme.
#
# Git Bash / MSYS / WSL-with-reg.exe equivalent of
# scripts/clean_flowpad_protocol.cmd. The macOS version lives in
# scripts/clean_flowpad_protocol.sh.
#
# Use this when you want a clean "FlowPad is not installed" baseline OR when
# a stale registry entry is causing the OS to launch the wrong FlowPad bundle
# (or a dev-mode Electron without the script-path argument, which makes
# deep-link cold-start lose the URL).
#
# What this script does:
#   1. Deletes the user-level HKCU\Software\Classes\flowpad registration.
#   2. Tries to delete the machine-level HKLM\Software\Classes\flowpad
#      registration. Requires an elevated ("Run as administrator") shell —
#      silently skipped otherwise.
#   3. Prints whatever flowpad:// handler entries remain.
#
# What this script does NOT do:
#   * Quit a running FlowPad / Electron. If a dev Electron is running it
#     will re-register itself on its next setAsDefaultProtocolClient call.
#     Quit it BEFORE running this script for a true clean state.
#   * Uninstall the production FlowPad app from Program Files.
#
# Usage (from Git Bash on Windows):
#   ./scripts/clean_flowpad_protocol_win.sh
#
# After running, also clear the browser-side cache:
#   localStorage.removeItem('flowpad-app-installed-at')

set -uo pipefail

if ! command -v reg.exe >/dev/null 2>&1; then
  echo "reg.exe not found on PATH. Run this from Git Bash on Windows." >&2
  exit 1
fi

echo "== 1. Removing user-level flowpad:// registration (HKCU) ============="
if reg.exe delete 'HKCU\Software\Classes\flowpad' /f >/dev/null 2>&1; then
  echo "   removed HKCU\\Software\\Classes\\flowpad"
else
  echo "   no HKCU entry found"
fi

echo
echo "== 2. Trying to remove machine-level registration (HKLM) ============="
echo "   (needs an elevated shell — skipped silently if not elevated)"
if reg.exe delete 'HKLM\Software\Classes\flowpad' /f >/dev/null 2>&1; then
  echo "   removed HKLM\\Software\\Classes\\flowpad"
else
  echo "   no HKLM entry found / not elevated"
fi

echo
echo "== 3. Verifying — any remaining flowpad:// handlers? ================="
if reg.exe query 'HKCU\Software\Classes\flowpad' >/dev/null 2>&1; then
  echo "   STILL PRESENT: HKCU\\Software\\Classes\\flowpad"
  reg.exe query 'HKCU\Software\Classes\flowpad\shell\open\command'
fi
if reg.exe query 'HKLM\Software\Classes\flowpad' >/dev/null 2>&1; then
  echo "   STILL PRESENT: HKLM\\Software\\Classes\\flowpad"
  reg.exe query 'HKLM\Software\Classes\flowpad\shell\open\command'
fi
if reg.exe query 'HKCR\flowpad' >/dev/null 2>&1; then
  echo "   NOTE: HKCR\\flowpad still resolves (merged view of HKLM+HKCU)."
fi

echo
echo "Done."
echo
echo "Next steps:"
echo "  1. Start your dev Electron once (npm start from desk-1845/electron)."
echo "     It re-registers itself by calling app.setAsDefaultProtocolClient."
echo
echo "  2. Verify the new HKCU entry includes BOTH electron.exe AND the"
echo "     main.js path (script-path argument required in dev mode):"
echo "       reg query \"HKCU\\Software\\Classes\\flowpad\\shell\\open\\command\""
echo "     Expected (default) value:"
echo "       \"C:\\...\\electron.exe\" \"C:\\...\\desk-1845\\electron\\main.js\" \"%1\""
echo
echo "  3. Quit Electron. Click \"Open in FlowPad\" in the browser."
echo
echo "  4. Tail the latest log under:"
echo "       %USERPROFILE%\\.flow\\logs\\main_desktop\\"
echo "     Expect a \"[deep-link] picked up from process.argv:\" line, then"
echo "     \"Loading UI from http://localhost:9007/auth/login_callback?...\""

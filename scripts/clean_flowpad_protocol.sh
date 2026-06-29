#!/usr/bin/env bash
# Reset the macOS state for the flowpad:// custom URL scheme.
#
# Use this when you want a clean "FlowPad is not installed" baseline — for
# example to test the MessageLanding "📥 Get FlowPad" path. macOS keeps stale
# protocol-handler registrations from:
#   • mounted Flowpad*.dmg installer volumes
#   • trashed Flowpad*.app bundles still indexed by Launch Services
#   • dev Electron builds that called setAsDefaultProtocolClient('flowpad')
#
# What this script does (non-destructive):
#   1. Ejects every /Volumes/Flowpad* mount.
#   2. Rebuilds the Launch Services database for user/local/system domains.
#      That alone purges trashed-app registrations on modern macOS — no need
#      to empty the Trash.
#   3. Verifies no `flowpad:` handler remains.
#
# What this script does NOT do:
#   • Delete files from your Trash.
#   • Quit any running FlowPad/Electron process. If a dev Electron is still
#     running, it'll re-register the handler on its next setAsDefaultProtocolClient
#     call — quit it before running this script if you want a true clean state.
#
# Usage:
#   ./scripts/clean_flowpad_protocol.sh
#
# After running, also clear the browser-side cache:
#   localStorage.removeItem('flowpad-app-installed-at')

set -euo pipefail

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"

echo "── 1. Ejecting Flowpad DMG mounts ────────────────────────────────────────"
shopt -s nullglob
mounts=(/Volumes/Flowpad*)
shopt -u nullglob
if [ ${#mounts[@]} -eq 0 ]; then
  echo "(none mounted)"
else
  for v in "${mounts[@]}"; do
    echo "  detaching $v"
    hdiutil detach "$v" -force
  done
fi

echo
echo "── 2. Rebuilding Launch Services database ────────────────────────────────"
"$LSREGISTER" -kill -r -domain local -domain system -domain user
echo "  done"

echo
echo "── 3. Verifying flowpad:// handlers ──────────────────────────────────────"
remaining=$("$LSREGISTER" -dump 2>/dev/null | grep -c "claimed schemes:.*flowpad" || true)
echo "  remaining flowpad: handlers = $remaining"
if [ "$remaining" -ne 0 ]; then
  echo
  echo "  ⚠  Handlers still registered. Most likely a running Electron build is"
  echo "     re-registering itself. Quit it and re-run this script."
  exit 1
fi

echo
echo "✅ Clean. flowpad:// has no registered handler on this machine."
echo "   Don't forget: localStorage.removeItem('flowpad-app-installed-at')"

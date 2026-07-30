#!/usr/bin/env bash
# Clone the real Chrome work profile into two disposable Playwright profiles.
#
# Chrome MUST be quit first — its SQLite files are exclusively locked, so a
# live copy yields a corrupt or empty cookie DB. This script quits it
# gracefully (Chrome saves the session and restores tabs next launch).
#
# Usage: clone-profiles.sh [source-profile-dir]
set -euo pipefail

SRC="${1:-$HOME/Library/Application Support/Google/Chrome/Profile 1}"
[ -d "$SRC" ] || { echo "source profile not found: $SRC" >&2; exit 1; }

echo "[clone] quitting Chrome (session is saved)…"
osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null || true
for _ in $(seq 1 40); do pgrep -x "Google Chrome" >/dev/null || break; done
pgrep -x "Google Chrome" >/dev/null && { echo "Chrome still running — quit it and retry" >&2; exit 1; }

# Caches are disposable and dominate the profile (~900MB of ~1.3GB).
EX=(--exclude "Service Worker/" --exclude "Cache/" --exclude "Code Cache/"
    --exclude "GPUCache/" --exclude "DawnCache/" --exclude "DawnGraphiteCache/"
    --exclude "DawnWebGPUCache/" --exclude "GrShaderCache/" --exclude "ShaderCache/"
    --exclude "Shared Dictionary/" --exclude "Sessions/" --exclude "Session Storage/"
    --exclude "Singleton*" --exclude "*.lock" --exclude "component_crx_cache/"
    --exclude "extensions_crx_cache/" --exclude "optimization_guide*")

for P in a b; do
  D="$HOME/.pw-profile-$P"
  rm -rf "$D"; mkdir -p "$D/Default"
  rsync -a "${EX[@]}" "$SRC"/ "$D/Default"/
  # Chrome 150 on macOS keeps Cookies at the profile ROOT (not Network/Cookies).
  # A zero here means the source layout differs — fix the path, don't proceed.
  n="$(sqlite3 "$D/Default/Cookies" "select count(*) from cookies;" 2>/dev/null || echo 0)"
  echo "[clone] profile-$P: $(du -sm "$D" | cut -f1)MB, $n cookies"
  [ "$n" -gt 0 ] || { echo "  NO COOKIES — clone is useless, check the source path" >&2; exit 1; }
done

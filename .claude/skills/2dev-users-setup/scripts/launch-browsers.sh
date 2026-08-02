#!/usr/bin/env bash
# Launch both clone browsers side by side with CDP enabled.
#
# Window widths are half the LOGICAL screen width (screen.width), not the
# physical Retina resolution — a 3024x1964 panel is 1512 logical.
#
# Usage: launch-browsers.sh [fe_port_a] [fe_port_b]
set -euo pipefail

FE_A="${1:-5002}"
FE_B="${2:-5003}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME" >&2; exit 1; }

# Half the logical screen, so the two windows sit flush.
HALF="$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null \
        | awk -F', ' '{print int($3/2)}')"
HALF="${HALF:-756}"

launch() {  # launch <profile-suffix> <cdp-port> <x> <url>
  "$CHROME" --user-data-dir="$HOME/.pw-profile-$1" --remote-debugging-port="$2" \
    --remote-allow-origins='*' --no-first-run --no-default-browser-check \
    --window-position="$3",25 --window-size="$HALF",950 "$4" >/dev/null 2>&1 &
}

launch a 9222 0       "http://localhost:$FE_A"
launch b 9223 "$HALF" "http://localhost:$FE_B"

for p in 9222 9223; do
  for _ in $(seq 1 60); do
    curl -s --max-time 1 "http://localhost:$p/json/version" >/dev/null 2>&1 && break
  done
  printf 'CDP %s: %s\n' "$p" \
    "$(curl -s --max-time 3 http://localhost:$p/json/version >/dev/null 2>&1 && echo alive || echo DOWN)"
done

echo "First launch of each clone raises one macOS Keychain prompt"
echo "('Chrome Safe Storage') — click Always Allow, or cookies stay encrypted."

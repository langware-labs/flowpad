#!/bin/bash
#
# Build + sign + notarize a standalone universal2 `flow-rs` for macOS and place
# it at flow_sdk/rust/bin/darwin/flow-rs for vendoring into the flowpad wheel.
#
# This is the standalone analogue of the Electron signing path
# (electron/signing/notarize.js): same Developer ID identity (CSC_NAME) and the
# same notarization credentials (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
# APPLE_TEAM_ID), but applied to the bare Mach-O binary instead of the .app/.dmg.
#
# NOTE: a bare executable cannot be *stapled* — `xcrun stapler` only targets
# .app / .dmg / .pkg. We submit + wait for notarization (so the signature is
# recorded with Apple), then skip stapling; the binary runs inside the
# already-trusted wheel/app context.
#
# Env:
#   CSC_NAME                      Developer ID identity
#                                 (default: "Langware Labs LTD (4FR748HA36)")
#   APPLE_ID                      Apple ID email (notarization)
#   APPLE_APP_SPECIFIC_PASSWORD   app-specific password (notarization)
#   APPLE_TEAM_ID                 Apple Developer Team ID (notarization)
#   SKIP_NOTARIZE=1               sign only, skip notarization (local dev)
#
# Usage:
#   source .env.pack.apple && scripts/sign_flow_rs_macos.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUST_DIR="${PROJECT_DIR}/flow_sdk/rust"
OUT_DIR="${PROJECT_DIR}/flow_sdk/rust/bin/darwin"
DEST="${OUT_DIR}/flow-rs"
CSC_NAME="${CSC_NAME:-Langware Labs LTD (4FR748HA36)}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: sign_flow_rs_macos.sh must run on macOS." >&2
  exit 1
fi

# Make rustup-installed cargo reachable from non-interactive shells (the same
# fallback logic used by electron/scripts/build-flow-rs.js).
if [[ -d "$HOME/.cargo/bin" && ":$PATH:" != *":$HOME/.cargo/bin:"* ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo not found. Install the Rust toolchain: https://rustup.rs" >&2
  exit 1
fi

echo "[sign-flow-rs-mac] ensuring rust targets (x86_64 + aarch64)..."
rustup target add x86_64-apple-darwin aarch64-apple-darwin

echo "[sign-flow-rs-mac] building both arches (release)..."
( cd "$RUST_DIR" && cargo build --release --bin flow-rs --target x86_64-apple-darwin )
( cd "$RUST_DIR" && cargo build --release --bin flow-rs --target aarch64-apple-darwin )

X64="${RUST_DIR}/target/x86_64-apple-darwin/release/flow-rs"
ARM64="${RUST_DIR}/target/aarch64-apple-darwin/release/flow-rs"
for f in "$X64" "$ARM64"; do
  [[ -f "$f" ]] || { echo "Error: expected build output missing: $f" >&2; exit 1; }
done

mkdir -p "$OUT_DIR"
echo "[sign-flow-rs-mac] lipo -> universal2..."
lipo -create -output "$DEST" "$X64" "$ARM64"
lipo -info "$DEST"

echo "[sign-flow-rs-mac] codesign (identity: ${CSC_NAME})..."
codesign --force --timestamp --options runtime --sign "$CSC_NAME" "$DEST"
codesign --verify --strict --verbose=2 "$DEST"
if codesign -dv "$DEST" 2>&1 | grep -q "Signature=adhoc"; then
  echo "Error: flow-rs is ad-hoc signed — Developer ID identity '${CSC_NAME}' not in keychain." >&2
  echo "       Check: security find-identity -v -p codesigning" >&2
  exit 1
fi

if [[ "${SKIP_NOTARIZE:-}" == "1" ]]; then
  echo "[sign-flow-rs-mac] SKIP_NOTARIZE=1 — signed but not notarized."
  echo "[sign-flow-rs-mac] OK -> ${DEST}"
  exit 0
fi

APPLE_ID="${APPLE_ID:-}"
APPLE_APP_SPECIFIC_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
if [[ -z "$APPLE_ID" || -z "$APPLE_APP_SPECIFIC_PASSWORD" || -z "$APPLE_TEAM_ID" ]]; then
  echo "Error: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set." >&2
  echo "       source .env.pack.apple && scripts/sign_flow_rs_macos.sh   (or set SKIP_NOTARIZE=1)" >&2
  exit 1
fi

echo "[sign-flow-rs-mac] notarizing (submit + wait)..."
TMP_DIR="$(mktemp -d)"
ZIP="${TMP_DIR}/flow-rs.zip"
ditto -c -k --keepParent "$DEST" "$ZIP"
# --timeout 1800 mirrors electron/signing/notarize.js (sync mode), not a
# symptom-masking widening.
NOTARY_JSON="$(xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 1800 --output-format json)"
rm -rf "$TMP_DIR"
STATUS="$(printf '%s' "$NOTARY_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))')"
echo "[sign-flow-rs-mac] notarization status: ${STATUS}"
if [[ "$STATUS" != "Accepted" ]]; then
  echo "Error: notarization not Accepted (status: ${STATUS})." >&2
  echo "$NOTARY_JSON" >&2
  exit 1
fi

echo "[sign-flow-rs-mac] OK -> ${DEST} (universal2, Developer ID signed + notarized)"

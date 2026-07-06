#!/usr/bin/env bash
# Put a Node.js toolchain (npx) on PATH, then exec the given command unchanged.
#
# Git — and therefore pre-commit — runs hooks with a stripped-down PATH that
# omits version-manager shims (nvm / fnm / volta) and often Homebrew too, so a
# bare `npx` in a hook `entry` fails with "npx: command not found" even though
# an interactive shell finds it fine. This wrapper loads the common managers
# (best-effort, no full `nvm use`) so the frontend/i18n hooks can run.
#
# Usage (from .pre-commit-config.yaml):
#   entry: scripts/node-hook.sh bash -c 'cd ui && npx prettier --write "${@#ui/}"' --

# nvm: add the newest installed node's bin to PATH (cheap; no sourcing nvm.sh).
if ! command -v npx >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  node_bin="$(ls -d "$NVM_DIR/versions/node"/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$node_bin" ] && export PATH="$node_bin:$PATH"
fi

# fnm: let it export its env if present.
if ! command -v npx >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env 2>/dev/null)" 2>/dev/null || true
fi

# Homebrew / system locations.
if ! command -v npx >/dev/null 2>&1; then
  for d in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/npx" ]; then export PATH="$d:$PATH"; break; fi
  done
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "pre-commit: npx (Node.js) not found on PATH — install Node via nvm/fnm/Homebrew." >&2
  exit 127
fi

exec "$@"

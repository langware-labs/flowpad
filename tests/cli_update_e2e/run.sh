#!/usr/bin/env bash
# The CLI update check, end to end in Docker: every harness CLI pinned old.
#   tests/cli_update_e2e/run.sh            # all modes
#   tests/cli_update_e2e/run.sh old slow   # some
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${IMAGE:-flowpad-cli-update:test}"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  mkdir -p dist && cp tests/cli_update_e2e/check.py dist/cli_update_check.py  # .dockerignore drops tests/
  docker build -q -f tests/cli_update_e2e/Dockerfile -t "$IMAGE" . >/dev/null
fi
modes=("$@"); [[ ${#modes[@]} -gt 0 ]] || modes=(old slow offline upgrade too_old)
for m in "${modes[@]}"; do
  echo "== $m"
  net=(); [[ "$m" == offline ]] && net=(--network none)
  docker run --rm "${net[@]}" "$IMAGE" "$m"
done

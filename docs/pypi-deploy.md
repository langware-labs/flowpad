---
id: 684208ee-360e-50e6-a71e-b642ca95ac57
---

# PyPI Deployment Guide

## Prerequisites

- PyPI credentials configured (either `TWINE_API_TOKEN` env var or `~/.pypirc`)
- `uv` installed (or `python3 -m build` / `python3 -m twine` as fallback)
- `gh` authenticated (used by the [Test gate](#test-gate-publishing-requires-the-release-prs-tests-to-have-passed) to read PR check status)
- `SLACK_BOT_TOKEN` set — a Slack bot token (scopes `chat:write` + `users:read.email`), used only by the Test gate to DM the person running the deploy about blocked / publish-anyway releases. The recipient is resolved from `git config user.email`, so that must be your Slack email. Keep the token secret; never echo it.

## Quick Deploy (the full end-to-end flow: commit → PR → merge → deploy → branch next)

> **Deploy from the release branch.** PyPI is released from the highest
> `release/vX.Y` branch, and the version bump must land on that same branch so
> its `flow_sdk/_version.py` always equals the version published to PyPI. Never
> release from a feature branch or `main` — the bump would diverge and the
> branch/PyPI versions would drift apart (a real bug we've hit).

This is the canonical release operation. It takes the current dev branch, lands
it on the release branch, publishes the new patch to PyPI, and names the dev
branch after the version just deployed. The release-branch steps run in an
**isolated git worktree** so they never disturb the shared main checkout —
concurrent sessions commit onto whatever branch is checked out there, so we must
not `git checkout` the release branch in the main working tree.

> **Branch-naming invariant: the dev branch is named after the *most recently
> deployed* version.** After publishing `0.2.<NEW>`, the dev branch is
> `0.2.<NEW>-fixes` — it holds the fixes that will become the *next* release.
> The next run bumps to `0.2.<NEW+1>` at deploy time and only **then** renames
> the branch to `0.2.<NEW+1>-fixes`. So in the common steady state the dev branch
> already equals `0.2.<NEW>-fixes` after the bump and step 4's rename is a no-op;
> it only actually renames when the deploy crossed into a new patch number. Do
> **not** pre-name the dev branch one ahead of what's on PyPI.

```bash
DEV_BRANCH=$(git branch --show-current)          # e.g. 0.2.68-fixes
git fetch origin --prune
RELEASE_BRANCH=$(git branch -r | grep -oE 'release/v[0-9]+\.[0-9]+' | sort -t. -k2,2n -u | tail -1)

# --- 1. COMMIT: land any working-tree changes on the dev branch, then push.
git add -A                                        # include untracked unless told otherwise
git commit -m "…"                                 # skip if the tree is already clean
git push origin "$DEV_BRANCH"

# --- 2. PR + MERGE: dev branch → release branch (server-side; no local checkout).
gh pr create --base "$RELEASE_BRANCH" --head "$DEV_BRANCH" \
  --title "Release: $DEV_BRANCH → $RELEASE_BRANCH" --body "Quick deploy."
gh pr merge "$DEV_BRANCH" --merge --delete-branch=false
git fetch origin "$RELEASE_BRANCH"

# --- 2b. TEST GATE: the latest PR merged into the release branch must have GREEN
#     PR Tests before we publish. Pending counts as "not passed". See the
#     "Test gate" section below for the block / Slack / publish-anyway rules.
GATE_JSON=$(gh pr list --base "$RELEASE_BRANCH" --state merged --limit 1 \
  --json number,url --jq '.[0]')
PR_NUM=$(echo "$GATE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['number'])")
PR_URL=$(echo "$GATE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
if gh pr checks "$PR_NUM"; then
  TESTS_PASSED=1                                  # all checks green → ok to publish
else
  TESTS_PASSED=0                                  # any failing OR pending → blocked
fi
# If TESTS_PASSED=0: do NOT run step 3. Post the "NOT deployed" Slack message
# (below) and STOP — unless the user has explicitly said publish anyway.

# --- 3. DEPLOY: bump + build + publish from an isolated worktree on the release branch.
#     Pick the new patch off the HIGHER of PyPI and the branch (never go backwards).
PYPI=$(curl -s https://pypi.org/pypi/flowpad/json | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['version'])")
NEW=0.2.X                                          # = max(PyPI, branch) patch + 1
WT=$(mktemp -d)/release-wt
git worktree add "$WT" "origin/$RELEASE_BRANCH"
ln -s "$(pwd)/ui/node_modules" "$WT/ui/node_modules"   # reuse deps so build_ui.py is fast
cd "$WT"
echo "__version__ = \"$NEW\"" > flow_sdk/_version.py
git add flow_sdk/_version.py
git commit -m "chore: bump version to $NEW for PyPI release"
git push origin "HEAD:$RELEASE_BRANCH"
rm -rf dist build flowpad.egg-info
python3 build_ui.py                                # REQUIRED — embeds frontend into the wheel
uv build                                           # reads version from _version.py
python3 -m twine upload "dist/flowpad-$NEW"*
cd -                                               # back to the main checkout
git worktree remove "$WT" --force

# --- 4. BRANCH NEXT: name the dev branch after the version JUST DEPLOYED ($NEW),
#        NOT $NEW+1. This is a no-op when the branch is already named so.
git fetch origin "$RELEASE_BRANCH"
git branch -m "$DEV_BRANCH" "$NEW-fixes"           # e.g. 0.2.68-fixes after deploying 0.2.68
git merge "origin/$RELEASE_BRANCH"                 # pick up the version bump so dev == released
git push -u origin "$NEW-fixes"
# If the rename changed the name, delete the now-stale remote dev branch:
[ "$DEV_BRANCH" != "$NEW-fixes" ] && git push origin --delete "$DEV_BRANCH"
```

The PR/merge in step 2 runs entirely on GitHub, and the deploy in step 3 runs in
a throwaway worktree — so the main working tree stays on the dev branch the whole
time. Only step 4 (`git branch -m`) touches it, renaming the branch in place to
`$NEW-fixes` (the version just deployed; same commit, new name) and merging in
the release bump.

## Test gate (publishing requires the release PR's tests to have passed)

**A version is only published to PyPI if the latest PR merged into the release
branch has GREEN PR Tests.** The `PR Tests` workflow (`.github/workflows/pr-tests.yml`)
runs the fast backend-free tiers (pytest `unit`+`cli`, vitest `unit`+`react`) on
every PR. It is intentionally **non-blocking for merge** — a PR can be merged
while its tests are red or still running — so this gate is the point where the
test result actually matters. **Pending counts as "not passed"**: if the checks
haven't finished, treat it as not passed and do not publish.

The Slack notice is a **direct message to whoever ran this deploy** — not a
shared channel. The recipient is resolved from `git config user.email` (so that
must match your Slack email). Define this helper once before the cases below:

```bash
# DM the deploying user via Slack. $SLACK_BOT_TOKEN needs chat:write +
# users:read.email. Never echo the token.
slack_dm() {
  local text="$1" uid
  uid=$(curl -fsS "https://slack.com/api/users.lookupByEmail?email=$(git config user.email)" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit('Slack lookup failed: '+str(d.get('error'))) if not d.get('ok') else print(d['user']['id'])") || return 1
  curl -fsS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H 'Content-type: application/json; charset=utf-8' \
    --data "$(python3 -c "import json,sys; print(json.dumps({'channel': sys.argv[1], 'text': sys.argv[2]}))" "$uid" "$text")" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit('Slack post failed: '+str(d.get('error'))) if not d.get('ok') else None"
}
```

Step 2b above computes `TESTS_PASSED`, `PR_NUM`, and `PR_URL`. Then:

* **`TESTS_PASSED=1`** → proceed with step 3 and publish normally. No Slack message.

* **`TESTS_PASSED=0` and the user has NOT said to publish anyway** → **do not run
  step 3.** DM the deploying user that it was blocked and STOP, telling them the
  tests didn't pass and linking the PR:

  ```bash
  slack_dm "⚠️ flowpad $NEW was NOT deployed to PyPI — tests did not pass in PR #$PR_NUM: $PR_URL"
  ```

* **`TESTS_PASSED=0` but the user explicitly says "publish anyway" / insists in
  any way** → run step 3 (publish) regardless, then DM the deploying user that it
  shipped with failing/pending tests:

  ```bash
  slack_dm "🚀 flowpad $NEW was deployed to PyPI even though tests did NOT pass in PR #$PR_NUM: $PR_URL"
  ```

Only these two cases send Slack. A clean, gated release (`TESTS_PASSED=1`) is silent.

## Validate Before Publishing

Check the wheel contains no unexpected heavy deps (e.g. `lancedb`):

```bash
unzip -p dist/flowpad-0.1.X-py3-none-any.whl "flowpad-0.1.X.dist-info/METADATA" | grep "Requires-Dist" | sort
```

## Validate After Publishing

Test in a clean isolated environment:

```bash
# Using venv
python3 -m venv /tmp/flowpad-test && /tmp/flowpad-test/bin/pip install flowpad==0.1.X

# Using uv tool
uv tool install flowpad --force

# Smoke test
/tmp/flowpad-test/bin/flow --help
```

## Local Deployment

Rehearse a release end-to-end on your own machine — exactly as if the package had
shipped to PyPI and the desktop app pulled the update — **without publishing
anything**. Give the build a throwaway local version so you can prove the running
server is *your* build and not the installed/published one.

> Give it `<version>+local` (e.g. `0.2.38+local`). This is a PEP 440 *local
> version label* — the `+` is required; a bare `-local` will not build.
>
> **Redeploying the same base version?** Check what's installed first (bare
> `flow` prints it). If that version already carries a local label, use the
> next number as the suffix: `+local2`, `+local3`, … Never reuse a label that
> is already deployed — with an identical version string you can't tell from
> `flow` / `upgrade --info` whether the running server is the new build or the
> previous one.

### 1. Stop the desktop app if it's running (and remember whether it was)

```bash
WAS_UP=$(pgrep -f "Flowpad.app" >/dev/null && echo 1 || echo 0)
[ "$WAS_UP" = 1 ] && osascript -e 'quit app "Flowpad"'
```

### 2. Build + install locally with a `+local` version

```bash
echo '__version__ = "0.2.38+local"' > flow_sdk/_version.py
rm -rf dist build flowpad.egg-info
python3 build_ui.py            # REQUIRED — bakes the UI into the wheel
python3 -m build               # or: uv build

# Install the freshly built wheel the SAME way your `flow` is installed
# (this is what `flow upgrade` auto-detects):
uv tool install --force ./dist/flowpad-*.whl
#   ...or for a pip install:
#   pip install --force-reinstall ./dist/flowpad-*.whl
```

### 3. Verify the prod server starts on 9007 and is the updated build

The desktop runs the **uv-tool** `flow`, so verify against that binary explicitly —
a repo editable install on your `PATH` reads `_version.py` live and would give a
false positive. The version is printed by **bare `flow`** (no subcommand);
`flow --version` is not a flag.

```bash
FLOW=~/.local/share/uv/tools/flowpad/bin/flow   # or `which flow` for a pip install

"$FLOW"                         # → flow 0.2.38+local   (bare flow prints version)
"$FLOW" stop                    # drop any old server/monitor first
FLOWPAD_NO_BROWSER=1 "$FLOW" start   # prod → http://127.0.0.1:9007 (no browser, like Electron)

# Wait for health — BOUNDED. A healthy start binds 9007 in a few seconds; if it
# doesn't, the start FAILED (it didn't just need more time — see the pitfall
# below), so fail loud and print the server log instead of polling forever.
for i in $(seq 1 15); do
  curl -fsS http://127.0.0.1:9007/api/v1/graph/bootstrap >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS http://127.0.0.1:9007/api/v1/graph/bootstrap >/dev/null 2>&1; then
  echo "FAILED: nothing bound 9007 — start did not come up. Last server log:"
  tail -20 "$(ls -t ~/.flow/instances/prod/logs/server/*.log | head -1)"
  exit 1
fi

"$FLOW" upgrade --info          # JSON status; "version" must read 0.2.38+local
echo "9007 OK"
```

Bare `flow` and the `version` field of `flow upgrade --info` must both read
`0.2.38+local`, and the server must answer on **9007** (prod port; dev is 9008).
Note `flow upgrade --info` reports the *installed* binary's version even when no
server is listening — so it is **not** proof the server came up. The bound-port
check above is what proves it; don't skip it.

### 4. Restart the desktop only if it was up at the start

```bash
[ "$WAS_UP" = 1 ] && open -a Flowpad
```

When done rehearsing, `git checkout flow_sdk/_version.py` to discard the `+local`
marker.

> **"Patch desktop" (the full prod-parity operation):** the steps above deploy the
> **backend wheel**. "Patch desktop" means BOTH halves built from the **latest release
> branch published on PyPI** (never the dev checkout): the backend wheel as
> `<latest>+local<count>`, and the Electron shell's `main.js` from the release tip stamped
> `<latest>-patch<count>` — incl. the macOS App-Management / asar-integrity / ad-hoc-resign
> gotchas — see
> [`local_patch.md` → Patching the desktop app (Electron shell)](./local_patch.md#patching-the-desktop-app-electron-shell).

## Known Pitfalls

### `flow start` silently no-ops when another instance backend is alive

`flow start` runs a singleton check and **exits without binding 9007** if it
detects an already-running `flow_sdk.server.run`, logging
`[singleton] Server already running (pid=…) — exiting`. A repo `.venv` dev
backend (e.g. the `oss`/`dev` instance on **9008**) trips this, so prod never
comes up. Worse, `"$FLOW" stop` can report **"Nothing was running"** — it only
manages the prod server it launched, not that other instance — giving false
comfort that the port is free.

Symptom: the verify loop never sees 9007 (the old unbounded `until curl …`
hung forever here). Diagnose, don't widen the wait:

```bash
tail -5 "$(ls -t ~/.flow/instances/prod/logs/server/*.log | head -1)"  # → the singleton line + offending pid
lsof -nP -p <pid> -iTCP -sTCP:LISTEN          # confirms it's a *different* instance (9008), not prod
```

If that process is your own dev instance, stop **that** instance (or run the
rehearsal on a port it isn't using) — do not just kill an unknown backend, and
never paper over it by extending the health-wait.

### Branch version drifts from the published PyPI version

If you deploy from a feature branch (or don't push the bump), the release
branch's `flow_sdk/_version.py` falls behind what's on PyPI. Always release from
the highest `release/vX.Y` branch (Quick Deploy step 0) and push the bump back
to it (step 6) so the two never diverge.

### `No module named build`

`python3 -m build` needs the `build` package, which isn't always installed. Use
`uv build` instead — it reads the version from `_version.py` and produces the
same `dist/flowpad-<version>-py3-none-any.whl` + `.tar.gz`.

### `npm: command not found` during `build_ui.py`

`build_ui.py` shells out to `npm`, which isn't on the PATH when node is
nvm-managed. Put it on the PATH first, e.g.:

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
```

### Server module paths must use `flow_sdk.server.*`

The server was merged from a standalone `server/` package into `flow_sdk/server/`. Any subprocess spawn must use the new path:

- `python -m flow_sdk.server.run` (NOT `python -m server.run`)
- `python -m flow_sdk.server.launch` (NOT `python -m server.launch`)
- uvicorn app string: `"flow_sdk.server.app:app"` (NOT `"server.app:app"`)

These appear in `flow_sdk/server/launch.py` (`start_server_process`, `start_monitor_detached`) and `flow_sdk/server/run.py` (uvicorn reload mode).

### Build UI before building wheel

`build_ui.py` compiles the React frontend into `flow_sdk/server/static/`. Without it, the wheel ships a stale or empty static dir and the server 404s on all JS/CSS.

### Heavy transitive deps break installs on new Python versions

`lancedb[embeddings]` was previously a dep and pulled in `ibm-watsonx-ai` → `pandas<2.2.0` which fails to build on Python 3.14+. It has been removed. If adding new ML-related deps, verify they install cleanly on Python 3.12–3.14 before publishing.

### PyPI propagation delay

After `twine upload`, the version may not be immediately available via `pip install`. Wait ~15–30 seconds before testing.

### `uv tool run flow` conflict

`uv tool run flow` resolves to a different package named `flow` on PyPI. Use `uvx --from flowpad flow` or the installed binary path directly (`~/.local/share/uv/tools/flowpad/bin/flow`).

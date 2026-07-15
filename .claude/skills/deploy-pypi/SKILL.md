---
id: 48abb112-7f90-5a11-8722-c73e801950af
name: deploy-pypi
description: Cut a Flowpad release — bump the version (patch by default; minor/major
  on request), build the wheel (UI baked in), publish to PyPI, tag + push to GitHub,
  and validate the install. Then, if the electron/ directory changed since the previous
  release, trigger the desktop build. Use when asked to deploy/release Flowpad, publish
  to PyPI, or cut a new version (including a new minor like 0.3.0).
tags:
- release
- pypi
- deploy
- electron
---

# Deploy Flowpad to PyPI

Cuts a Flowpad release. The canonical, maintained path is the deploy script
`scripts/deploy_to_github.sh` — it does everything the *Manual deploy* section
below describes by hand, in the correct order, with validation gates:

1. Bumps the version in `flow_sdk/_version.py` — **patch by default**; pass
   `--minor` / `--major` / `--version X.Y.Z` to bump a different component
2. Builds + signs the vendored `flow-rs` binaries (skippable)
3. Commits the bump, creates an annotated `v<version>` tag, pushes branch + tag
4. Builds the UI (`build_ui.py`) and the wheel/sdist, publishes to PyPI
5. Validates the install in a clean environment

> **The baseline is always the latest release, not a fixed `0.2`.** The version
> family floats: derive "current" from `flow_sdk/_version.py` / PyPI-latest, never
> assume a hardcoded major.minor. A **patch** rides the existing `release/vX.Y`
> branch; a **minor/major** opens a *new* `release/vX.(Y+1)` (or `v(X+1).0`) branch
> off the release point — see *Minor / major releases* below.

After a release actually publishes a new version to PyPI, this skill **also**
checks whether `electron/` changed since the previous release and, only if both are
true, kicks off the desktop installer build (a `--no-pypi` or failed run does not).

> **This publishes to PyPI and pushes a tag — both hard to undo.** Confirm with the
> user before running a real (non-`--no-pypi`) deploy. State the current version and
> the patch-bumped version that will be published.

---

## Prerequisites

```bash
which uv            # build tool
gh auth status      # needed for flow-rs signing + the desktop build trigger
# PyPI creds: TWINE_API_TOKEN env var OR ~/.pypirc
[ -n "$TWINE_API_TOKEN" ] || ls ~/.pypirc
```

If any fail, stop and report. (`--no-pypi` skips the PyPI publish; `--skip-flow-rs-sign`
skips signing if `gh` access to `langware-labs/flowpad-desktop` is unavailable.)

For the **manual** flow (below) you additionally need:

- `SLACK_BOT_TOKEN` — a Slack bot token (scopes `chat:write` + `users:read.email`),
  used only by the *Test gate* to DM the person running the deploy about blocked /
  publish-anyway releases. The recipient is resolved from `git config user.email`,
  so that must be your Slack email. Keep the token secret; never echo it.

---

## Automated deploy (the maintained path)

### Step 1 — Record the previous release tag (BEFORE deploying)

The desktop check in Step 3 must diff against the release that was current *before*
this deploy. Capture it now (via `gh`, so it reflects what's actually on the remote
rather than whatever tags happen to be local), because the deploy creates a new tag.

> Releases here are tracked by **git tags**, not GitHub *Releases* — the deploy
> script pushes `v<version>` tags but does not call `gh release create` (GitHub's
> "Latest release" lags well behind). So resolve the highest `v#.#.#` **tag**, the
> same way `build-flowpad-desktop` resolves branches — not `gh release view`.

```bash
PREV_TAG=$(gh api repos/langware-labs/flowpad/tags --paginate -q '.[].name' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
git fetch --tags origin "$PREV_TAG"   # ensure it's a local ref for the Step 3 diff
echo "Previous release: $PREV_TAG"
```

### Step 2 — Run the deploy

Show the user the version transition first, then run the script. The script bumps
**patch** unless you pass `--minor` / `--major` / `--version X.Y.Z`:

```bash
CURRENT=$(grep -o '[0-9]*\.[0-9]*\.[0-9]*' flow_sdk/_version.py)
echo "Deploying from $CURRENT (patch bump unless --minor/--major/--version given)"
```

After confirmation, run with the bump level the user asked for (default patch):

```bash
./scripts/deploy_to_github.sh             # patch:  X.Y.Z -> X.Y.(Z+1)
./scripts/deploy_to_github.sh --minor     # minor:  X.Y.Z -> X.(Y+1).0   (e.g. 0.2.78 -> 0.3.0)
./scripts/deploy_to_github.sh --version 0.3.0   # publish this exact version
```

Common variants:

| Goal                                         | Command                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| Full release, patch bump (default)           | `./scripts/deploy_to_github.sh`                      |
| Minor release (new `release/vX.Y` first)     | `./scripts/deploy_to_github.sh --minor`              |
| Exact version (no bump)                      | `./scripts/deploy_to_github.sh --version X.Y.Z`      |
| Skip the pre-deploy test run                 | `./scripts/deploy_to_github.sh --skip-tests`         |
| Tag + GitHub only, no PyPI                   | `./scripts/deploy_to_github.sh --no-pypi`            |
| Skip flow-rs (re)signing                     | `./scripts/deploy_to_github.sh --skip-flow-rs-sign`  |

The script guards against going backwards: it refuses any `--version` / bump that
doesn't sort strictly above the current `_version.py` value.

The script is `set -e` and fails fast — if it exits non-zero (tests, signing,
asset check, or install validation), the release did **not** publish. Report the
failure; do not retry blindly.

After it completes, capture the new tag and confirm whether a new version was
actually **published to PyPI** — Step 3 depends on this. A run does NOT publish if
you passed `--no-pypi` or the script exited non-zero, so check for the version
directly on PyPI rather than assuming the deploy implies a publish:

```bash
NEW_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]' | head -1)
NEW_VERSION=${NEW_TAG#v}
echo "Released: $NEW_TAG"

# Did this run actually upload a new version to PyPI? (allow for propagation delay)
if curl -fsS "https://pypi.org/pypi/flowpad/$NEW_VERSION/json" >/dev/null 2>&1; then
  PUBLISHED=1    # new version is live on PyPI → a desktop release may be warranted
else
  PUBLISHED=0    # --no-pypi, a failed deploy, or not yet propagated → do NOT release desktop
fi
echo "PUBLISHED=$PUBLISHED"
```

### Step 3 — Desktop build if we published to PyPI AND electron/ changed

The desktop release fires only when **both** conditions hold:

1. **This run actually published a new version to PyPI** (`PUBLISHED=1` from Step 2), and
2. **`electron/` changed** between the previous release and the just-released HEAD.

Either alone is not enough. A `--no-pypi` or failed run shipped nothing, so there's
no new version for a desktop release to wrap. And a PyPI-only patch that didn't
touch `electron/` reuses the existing desktop shell — no rebuild needed. Check both:

```bash
if [ "$PUBLISHED" != 1 ]; then
  echo "No new version published to PyPI this run — desktop build SKIPPED."
elif git diff --quiet "$PREV_TAG" HEAD -- electron/; then
  echo "Published $NEW_TAG but no electron/ changes since $PREV_TAG — desktop build NOT needed."
else
  echo "Published $NEW_TAG AND electron/ changed since $PREV_TAG — desktop build needed:"
  git diff --stat "$PREV_TAG" HEAD -- electron/
fi
```

**Only if both conditions hold**, trigger the desktop build directly — dispatch the
`build-desktop.yml` workflow with `flowpad_branch` set to the **current branch**
(`<branch>` below):

```bash
BRANCH=$(git branch --show-current)
gh workflow run build-desktop.yml --repo langware-labs/flowpad-desktop \
  -f dry_run=false -f platforms=all -f flowpad_branch="$BRANCH"
```

> `dry_run=false` **publishes a GitHub desktop release.** Get explicit user
> confirmation before triggering it. Then watch the run:
>
> ```bash
> gh run list --repo langware-labs/flowpad-desktop --workflow build-desktop.yml --limit 5
> gh run watch <run-id> --repo langware-labs/flowpad-desktop
> ```

---

## Manual deploy (what the script automates)

Use this when the script is unavailable or you need to intervene at a single step.
It is the full end-to-end flow: **commit → PR → merge → deploy → branch next**.

> **Deploy from the release branch.** PyPI is released from the highest
> `release/vX.Y` branch, and the version bump must land on that same branch so
> its `flow_sdk/_version.py` always equals the version published to PyPI. Never
> release from a feature branch or `main` — the bump would diverge and the
> branch/PyPI versions would drift apart (a real bug we've hit).

This takes the current dev branch, lands it on the release branch, publishes the
new version to PyPI, and names the dev branch after the version just deployed. The
release-branch steps run in an **isolated git worktree** so they never disturb the
shared main checkout — concurrent sessions commit onto whatever branch is checked
out there, so we must not `git checkout` the release branch in the main working tree.

> The steps below use `$RELEASE_BRANCH` / `$NEW` (derived at deploy time, per the
> floating-baseline rule in the overview) so they work for whatever `vX.Y` is
> current — never hardcode `0.2`. A **patch** stays on the existing
> `$RELEASE_BRANCH`; a **minor or major** opens a new one first (*Minor / major releases*).

> **Branch-naming invariant: the dev branch is named after the *most recently
> deployed* version `$NEW`.** After publishing `$NEW` (e.g. `0.2.79` or `0.3.0`),
> the dev branch is `$NEW-fixes` — it holds the fixes that will become the *next*
> release. The next run bumps `$NEW` again at deploy time and only **then** renames
> the branch. So in the common steady state the dev branch already equals
> `$NEW-fixes` after the bump and step 4's rename is a no-op; it only actually
> renames when the deploy crossed into a new version number. Do **not** pre-name
> the dev branch one ahead of what's on PyPI.

```bash
DEV_BRANCH=$(git branch --show-current)          # e.g. 0.2.68-fixes
git fetch origin --prune
RELEASE_BRANCH=$(git branch -r | grep -oE 'release/v[0-9]+\.[0-9]+' | sort -V -u | tail -1)

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
#     `Tests` checks before we publish. Pending counts as "not passed". See the
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
#     Pick the new version off the HIGHER of PyPI and the branch (never go backwards).
PYPI=$(curl -s https://pypi.org/pypi/flowpad/json | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['version'])")
# Patch (default): max(PyPI, branch), bump the patch component.
# Minor: bump the minor and reset patch to 0 (e.g. 0.2.79 -> 0.3.0); see the
#        "Minor / major releases" section — $RELEASE_BRANCH must be the NEW line.
NEW=X.Y.Z                                          # computed from the baseline above
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

### Test gate (publishing requires the release PR's tests to have passed)

**A version is only published to PyPI if the latest PR merged into the release
branch has GREEN checks.** The `Tests` workflow (`.github/workflows/test.yml`)
runs three jobs on every PR: `backend (pytest unit + api)`, `frontend (tsc +
vitest unit/react + i18n)`, and `e2e (live backend: vitest headless/api +
playwright)`. It is intentionally **non-blocking for merge** — a PR can be merged
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

---

## Minor / major releases (new release branch)

A **patch** ships from the current `release/vX.Y` branch. A **minor** (`0.2.x → 0.3.0`)
or **major** starts a *new* release line — cut the branch first, then deploy from it
so the release source is never a feature branch or `main`. Everything else (PR +
merge, test gate, worktree build, dev-branch rename) is identical to a patch.

> **Releases are a continuum — a new line ALWAYS branches off the *previous*
> release tip, never off the dev branch.** Every `release/vX.Y` descends from the
> one before it, so version lineage and tags stay continuous and the new line
> never drops a fix that already shipped on the old one. Branching a new line off
> the dev branch instead would (a) fork history away from the release continuum
> and (b) make the dev→new-line PR empty (same commit), which in turn leaves the
> test gate with no merged PR to read. Cutting off the prior release keeps the
> dev→new-line PR a real diff and the gate a real merged PR — so the flow really
> is identical to a patch.

1. **Find the live baseline** — the highest release branch / PyPI version, not a
   hardcoded `0.2`:

   ```bash
   git fetch origin --prune                           # refreshes every origin/* (incl. release lines)
   PREV_REL=$(git branch -r | grep -oE 'release/v[0-9]+\.[0-9]+' | sort -V | tail -1)
   echo "Latest release branch: $PREV_REL"            # e.g. release/v0.2
   ```

2. **Decide the new version and cut its release branch** off the previous release
   tip (the continuum — NOT the dev branch), then push it:

   ```bash
   NEW=0.3.0                                          # the X.(Y+1).0 (or (X+1).0.0) you're cutting
   NEW_REL=release/v${NEW%.*}                         # release/v0.3  (strip the patch component)
   git branch "$NEW_REL" "origin/$PREV_REL"
   git push -u origin "$NEW_REL"
   ```

3. **Deploy from it** with the matching bump:

   ```bash
   # Automated: switch to the new release branch first, then:
   git switch "$NEW_REL"
   ./scripts/deploy_to_github.sh --minor              # or --version 0.3.0

   # Manual: run the "Manual deploy" flow with RELEASE_BRANCH=$NEW_REL and NEW=0.3.0.
   # Step 2 PRs the dev branch into $NEW_REL (a real diff), step 2b's gate reads
   # that merged PR, the worktree bump writes 0.3.0, the tag is v0.3.0, and step 4
   # renames the dev branch to 0.3.0-fixes.
   ```

4. **Rename the dev branch** to the *just-deployed* version (same invariant as a
   patch): after shipping `0.3.0` the dev branch is `0.3.0-fixes`. See
   `feedback-release-flow` memory for the exact rename rule.

> Do **not** try to reach a minor by editing `_version.py` and running a plain patch
> deploy — `patch+1` from `0.2.x` can never produce `0.3.0`. Use `--minor` /
> `--version`.

---

## Validate before publishing

Check the wheel contains no unexpected heavy deps (e.g. `lancedb`):

```bash
unzip -p dist/flowpad-$NEW-py3-none-any.whl "flowpad-$NEW.dist-info/METADATA" | grep "Requires-Dist" | sort
```

## Validate after publishing

The automated script self-validates (clean-env install + `validate_install.sh`).
For a manual check, test in a clean isolated environment:

```bash
# Using venv
python3 -m venv /tmp/flowpad-test && /tmp/flowpad-test/bin/pip install flowpad==$NEW

# Using uv tool
uv tool install flowpad --force

# Smoke test
/tmp/flowpad-test/bin/flow --help
```

PyPI versions are immutable — you cannot overwrite or delete-then-reuse a published
version. If a published build is broken, bump again and ship a new patch; never try
to reuse the version string.

---

## Local deployment (rehearse without publishing)

Rehearse a release end-to-end on your own machine — exactly as if the package had
shipped to PyPI and the desktop app pulled the update — **without publishing
anything**. **Local deployment builds from your current working tree and branch**
(your in-progress version), never from the release branch tip. If your dev branch
is behind the latest release line, pull and merge the latest release branch into
your dev branch first — so your changes ride on top of the latest fixes — then
build from your now-updated working tree. Never switch to and build the release
branch tip; that would drop your code. Give the build a throwaway local version
label (bumped above whatever `+local` is already installed) so you can prove the
running server is *your* updated build and not a previous deployment or the
released version.

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

> **"Patch desktop" (the full prod-parity operation):** distinct from the default local
> deployment above—which rehearses YOUR in-progress code by building from your working
> tree—"Patch desktop" is a separate prod-parity operation that deliberately reproduces
> what users run by building BOTH halves from the **latest release branch published on
> PyPI** (never the dev checkout). This means the backend wheel as `<latest>+local<count>`,
> and the Electron shell's `main.js` from the release tip stamped `<latest>-patch<count>`
> — incl. the macOS App-Management / asar-integrity / ad-hoc-resign gotchas — see
> [`local_patch.md` → Patching the desktop app (Electron shell)](../../../docs/local_patch.md#patching-the-desktop-app-electron-shell).

---

## Known pitfalls

### Watching the pre-deploy test gate (it can run 40+ minutes)

The script's test step tees its output to a timestamped log and announces the
path up front (`Running tests... (live log: tail -f /tmp/deploy-tests-*.log)`),
with `--durations=20` so the slowest tests are listed at the end. To watch
progress from another shell: `tail -f <that path>`. If you wrap the deploy (or
a manual pytest gate) yourself, do NOT pipe it through `tail`/`head` — that
buffers everything until the run ends and the gate looks hung. Run it with
output flowing to a file (`| tee run.log`) and `PYTHONUNBUFFERED=1` so lines
stream live.

### Windows: `python3: command not found` / long_tests break pytest collection

Two Windows-specific failures in the script's gate, both fatal before any test
runs:

- **`python3` doesn't exist in Git Bash** (only `python`). Put a shim on PATH
  that execs the *project* env's python (plain `python` may resolve to the
  uv-tool flowpad install, which has no pytest):

  ```bash
  printf '#!/bin/bash\nexec uv run --project /c/projects/flowpad python "$@"\n' > /tmp/bin/python3
  chmod +x /tmp/bin/python3; export PATH=/tmp/bin:$PATH
  ```

- **`tests/long_tests/` files `import pty`** (unix-only; no `termios` on
  Windows), which aborts pytest **collection** for the whole suite — the gate
  fails without running anything. Run the gate manually with
  `--ignore=tests/long_tests`, confirm green, then deploy with `--skip-tests`
  (CI's PR gate covers the fast tiers). Don't `--skip-tests` without that
  manual green run.

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
the highest `release/vX.Y` branch and push the bump back to it so the two never
diverge.

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

### Locale `.po` files show up as modified after every build (`lingui extract`)

`build_ui.py` runs `npm run build`, whose script is `lingui extract && lingui compile && vite build`. **`lingui extract` rewrites `ui/src/locales/{en-US,ar,he}/messages.po` in place** every build — so any deploy or local rehearsal that builds the UI leaves those three catalogs dirty in the working tree. This is generated output, not an edit you made.

`ui/lingui.config.ts` sets `formatOptions: { lineNumbers: false }` so the volatile `:<line>` suffix is dropped from the `#: file.tsx` source references — otherwise every edit that shifts line numbers would rewrite hundreds of location comments (a 1000+ line diff with no real string changes). With that in place, a build only touches the catalogs when strings are genuinely added/removed/relocated.

So after a build: if `git diff ui/src/locales/` shows only real string changes, commit them; if it's empty or you didn't intend to change any strings, `git checkout ui/src/locales/` to discard the regenerated copy. Do **not** carry this churn into a release commit or mistake it for hand edits.

---

## Reference

- `docs/local_patch.md` — rehearse a release locally (`<version>+local`) without
  publishing, and "patch desktop" for full prod-parity testing.

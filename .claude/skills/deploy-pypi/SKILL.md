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
`scripts/deploy_to_github.sh` — it does everything `docs/pypi-deploy.md` describes
manually, in the correct order, with validation gates:

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

After a successful deploy, this skill **also** checks whether `electron/` changed
since the previous release and, if so, kicks off the desktop installer build.

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

---

## Step 1 — Record the previous release tag (BEFORE deploying)

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

---

## Step 2 — Run the deploy

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

After it completes, capture the new tag:

```bash
NEW_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]' | head -1)
echo "Released: $NEW_TAG"
```

---

## Step 3 — Desktop build if electron/ changed

If `electron/` changed between the previous release and the just-released HEAD, the
desktop app needs rebuilding too. Check it:

```bash
if git diff --quiet "$PREV_TAG" HEAD -- electron/; then
  echo "No electron/ changes since $PREV_TAG — desktop build NOT needed."
else
  echo "electron/ changed since $PREV_TAG — desktop build needed:"
  git diff --stat "$PREV_TAG" HEAD -- electron/
fi
```

**If there are changes**, trigger the desktop build directly — dispatch the
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

## Minor / major releases (new release branch)

A **patch** ships from the current `release/vX.Y` branch. A **minor** (`0.2.x → 0.3.0`)
or **major** starts a *new* release line — cut the branch first, then deploy from it
so the release source is never a feature branch or `main`.

1. **Find the live baseline** — the highest release branch / PyPI version, not a
   hardcoded `0.2`:

   ```bash
   LATEST_REL=$(git branch -r | grep -oE 'release/v[0-9]+\.[0-9]+' | sort -V | tail -1)
   echo "Latest release branch: $LATEST_REL"          # e.g. release/v0.2
   ```

2. **Create the new release branch** off that baseline's tip (the deploy point —
   usually your merged dev branch or the latest release tag), and push it:

   ```bash
   NEW_REL=release/v0.3                                # the X.(Y+1) you're cutting
   git branch "$NEW_REL" <deploy-point>               # e.g. HEAD of the merged dev branch
   git push -u origin "$NEW_REL"
   ```

3. **Deploy from it** with the matching bump:

   ```bash
   git switch "$NEW_REL"
   ./scripts/deploy_to_github.sh --minor              # or --version 0.3.0
   ```

4. **Rename the dev branch** to the *just-deployed* version (same invariant as a
   patch): after shipping `0.3.0` the dev branch is `0.3.0-fixes`. See
   `feedback-release-flow` memory for the exact rename rule.

> Do **not** try to reach a minor by editing `_version.py` and running a plain patch
> deploy — `patch+1` from `0.2.x` can never produce `0.3.0`. Use `--minor` /
> `--version`.

---

## Validation & rollback

The deploy script self-validates (clean-env install + `validate_install.sh`). For
extra manual checks see `docs/pypi-deploy.md` → *Validate After Publishing*.

PyPI versions are immutable — you cannot overwrite or delete-then-reuse a published
version. If a published build is broken, bump again and ship a new patch; never try
to reuse the version string.

## Reference

- `docs/pypi-deploy.md` — the manual step-by-step the script automates, plus known
  pitfalls (module paths, build-UI-before-wheel, heavy deps, propagation delay).
- `docs/local_patch.md` — rehearse a release locally (`<version>+local`) without
  publishing, and "patch desktop" for full prod-parity testing.

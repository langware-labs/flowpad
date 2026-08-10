---
id: 358519e6-62a2-462f-91b0-ae97df27a037
name: e2b-builder
description: Build, validate and pin the FlowPad E2B sandbox template (flowpad-exec-env). Use when asked to build/rebuild the e2b template, roll a new sandbox image, pick up a new flowpad release in sandboxes, or test unreleased flowpad-oss work in a real sandbox.
tags:
- e2b
- sandbox
- build
- release
---

# E2B template builder

A thin wrapper. **`ops/e2b/flowpad-exec-env/README.md` is the source of truth** — read it and
follow it. Everything below is routing and the traps that cost real time, not a second copy of
the instructions.

## First, always

Everything here — `README.md`, `build.sh`, `validate.sh`, `templates/` — lives in the
**flowpad-hub** repo, at `ops/e2b/flowpad-exec-env`. This skill is reachable from both checkouts
(it is symlinked into flowpad-hub), so do not assume the working directory:

```bash
cd <flowpad-hub checkout>/ops/e2b/flowpad-exec-env   # sibling of the flowpad checkout
```

Read `README.md` before running anything. Do not reconstruct the procedure from memory or from
this file — the scripts and the ledger change, and a stale recollection here is exactly how a
template gets minted under the wrong name.

## Pick the mode

| Ask | Mode |
|---|---|
| "rebuild the template", "pick up the new flowpad release", rolling a version | **Released.** README → *Versions → Rolling a new version* |
| Exercising unreleased `flowpad-oss` / `flow_sdk` work in a real sandbox | **Local.** README → *Testing an unreleased flowpad-oss build (`build.sh --local`)* |

If unsure which, ask — they are not interchangeable, and a `--local` build under a release name
puts a private wheel into production.

## Non-negotiables

These are the ones the README calls out and that are worth failing loudly on:

- **Never rename a file in `templates/`.** It is a committed ledger of registered template ids,
  not scratch. Renaming makes a bump *rename* the previous release out of existence instead of
  minting a new one.
- **Validate with `--version`, never bare `all`.** Once `templates/` holds more than one release,
  bare `all` resolves to the newest — which may not be what you just built.
- **Commit `templates/` AND `config.py` together.** The ledger alone leaves the hub on the old
  version.
- **The preflight team check is a feature.** If it aborts, the E2B credential is on the wrong
  team; fix with `e2b auth configure`. Do not reach for `SKIP_E2B_PREFLIGHT` — its only legitimate
  use is bootstrapping a genuinely new account.
- **`build.sh` refuses to rebuild over a changed Dockerfile.** That is the guard working: bump
  `--revision N` rather than defeating it.
- **A green build is not a correct image.** Layer caching has shipped the wrong app version under
  the right name before. Verify the `flowpad_version` recorded in the ledger entry.

## Noise you can ignore

A long run of `Unsupported instruction: COMMENT` on stderr before `Build started`. The Dockerfile
is comment-heavy on purpose; the build proceeds normally.

## Report back

State plainly: which templates were minted (full names), the `flowpad_version` they carry,
whether `validate.sh` was run and its result, and whether `config.py: default_e2b_version` was
repointed and committed. If any step was skipped, say which and why — a partial roll that reads
as complete is the failure mode this skill exists to prevent.

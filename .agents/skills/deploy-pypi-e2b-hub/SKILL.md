---
id: 59653d13-f0f9-4fab-b544-24cc9ed4717a
name: deploy-pypi-e2b-hub
description: Ship a Flowpad change all the way to users — release the app to PyPI,
  roll the e2b sandbox template onto it, move the hub's pins, and deploy the hub to
  staging and prod. Use when a fix must reach a deployed environment and not just
  a branch, when a change touches BOTH the app and the sandbox image, or when someone
  asks to "release and deploy everything". For a PyPI release alone use deploy-pypi;
  for a template alone use e2b-builder; for a hot patch onto one VM use deploy-to-gcp-env.
tags:
- release
- deploy
- e2b
- hub
---

# Ship a Flowpad release end to end

**This skill owns the ORDER, the things that must move together, and the approval gates.
It owns no mechanics.** Every actual step belongs to a skill that already documents it:

| Step | Skill | Repo |
|---|---|---|
| Release the app to PyPI | `deploy-pypi` | `flowpad` |
| Build + validate the sandbox template | `e2b-builder` | `flowpad-hub` |
| Hot-patch one VM (NOT a release) | `deploy-to-gcp-env` | `flowpad-hub` |

Read those when you get to them. Do not restate their steps here or work from memory of
them — two descriptions of one procedure drift, and the wrong one is always the one being
followed.

---

## The four things that move together

A release is not one version. It is **four values that must all name the same app
release**, spread across two repos:

1. `flow_sdk/_version.py` — the app published to PyPI *(flowpad)*
2. `ops/e2b/flowpad-exec-env/templates/*.toml` — the ledger of built templates *(flowpad-hub)*
3. `flowpad/config.py: default_e2b_version` — which template the hub launches *(flowpad-hub)*
4. **the `flowpad` version in `uv.lock`** — what the hub installs and therefore the UI it
   serves *(flowpad-hub)*

Miss any one and everything still deploys green. The failures are silent and each looks
like something else — see *Traps*.

`flowpad/hub/tests/unit/test_e2b_pin_matches_flowpad_lock.py` enforces 3 ↔ 4. Nothing
enforces the rest; that is what this skill is for.

---

## The order, and why it cannot change

```
1. app PR merged into release/v0.2                      [user merges]
2. release the app to PyPI            -> deploy-pypi    [bump PR: auto-merge]
3. build + validate the e2b template  -> e2b-builder
4. hub PR: ledger + default_e2b_version + uv.lock pin   [user merges]
5. hub version bump + tag                               [bump PR]
6. deploy the hub: staging, then prod                   [prod: confirm]
```

**2 before 3** — `build.sh` resolves the newest release *from PyPI*. Building first mints a
template carrying the previous app version, under the new name.

**3 before 4** — the pin must point at a ledger entry that exists. See the first trap.

**4 before 5** — a deploy ships the repo at its tag. A pin merged after the tag is not in
the release.

**5 before 6** — `deploy.yml` takes a version (`vX.Y.Z`); deploying the previous tag ships
the previous ledger and changes nothing.

---

## Traps this exists to prevent

**A pin that outruns its ledger — silent downgrade.** `resolve_template_version` falls
*down* to the newest built version it can see, by design (rolling forward would put an
unvalidated image under a hub tested against an older one). A deployed hub resolves
templates from the ledger **it shipped with**, so bumping the pin without a hub release
launches the OLD template and says nothing. Observed: config said `0-2-130`, sandboxes ran
`0.2.128`, and the only symptom was a stale version in the app footer.

**A lock that never moved — the hub serves an old UI.** The hub serves the desktop SPA out
of the *installed* `flowpad` wheel, not out of the repo. A hub deploy installs what
`uv.lock` says and **overwrites any hot patch**. Observed: prod deployed green while
serving a UI three releases old — no error, the feature was simply absent.

**A green build is not a correct image.** Layer caching has shipped the wrong app under
the right name. Verify from the build log that `pip show flowpad` reported the version you
asked for — not just the ledger entry, which records what was *requested*.

**Strings can ship without their code.** `lingui extract` can sweep new `<Trans>` strings
into the catalogs from an uncommitted working tree, so a release ships the translations for
a feature whose code is on an unmerged branch. Before publishing, grep the built wheel for
a distinctive identifier from the change itself, not for its copy.

---

## Gates

Per-action approval, every time — see the `feedback_git_no_commit_pr_merge_without_permission`
and `feedback_no_deploy_without_permission` memories.

- **Feature PRs** — the user merges. Never merge one to keep the chain moving.
- **Version-bump PRs** — auto-merge is granted in the `flowpad` repo when the PR's ONLY
  content is the version going up one number. Not for anything else, and not for the hub.
- **Prod deploy** — confirm before dispatching, each time, even mid-sequence.
- **Release branches** are written only by merging a PR, including version bumps. The
  deploy script pushes the bump directly; do not let it.

---

## Verify, do not assume

Three checkpoints, each of which has caught a real failure:

1. **Before publishing** — the built wheel contains the change (grep an identifier from
   the code, not from a translated string).
2. **After building the template** — the build log's `pip show flowpad` says the version
   you asked for.
3. **After deploying** — the environment reports the new hub version AND the new app
   version, and a NEWLY CREATED sandbox reports the new app version in its footer.
   Existing sandboxes keep their image; only new ones move.

## Report back

State which of the four values moved, the template ids minted, whether `validate.sh` ran
and its result, which environments were deployed, and what remains. A partial roll that
reads as complete is the failure this skill exists to prevent — and every step of it is
individually silent.

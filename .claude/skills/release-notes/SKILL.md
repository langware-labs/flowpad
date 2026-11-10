---
id: 3f7cc368-238c-4e58-bc4f-887e66d468a8
name: release-notes
description: 'Writes the Flow SDK release notes for one version into flow_sdk/system_projects/flowpad_assistant/releases/<version>/RELEASE_NOTES.md
  (shipped in the wheel, opened by the version popover''s Release notes chip). Skips
  the write when the notes are already fresh for the commits since the previous tag.
  Started in the background by scripts/deploy_to_github.sh; also run by hand: `release-notes
  <version> [--from <tag>] [--to <rev>]`. Triggers on "write the release notes", "release
  notes for 0.2.x", "regenerate the release notes".'
---

# release-notes — one version's notes, written once

## 1. Plan (no LLM)

```bash
python3 .claude/skills/release-notes/scripts/plan.py <version> [--from <tag>] [--to <rev>]
```

- `fresh` → **stop**. Say "notes for <version> are up to date" and write nothing.
- `missing` / `stale` → write the file from `commits` (step 2). `stale` = a user-visible commit was
  added since the notes were written: rewrite the whole file from the current list.

Defaults: `--from` = newest `v*` tag before this version, `--to` = HEAD (at deploy time the version
is not tagged yet). For a version already tagged, pass `--to v<version>`.

## 2. Write

Read each commit (`git show --stat <subject match>` when the subject is unclear) and write:

```markdown
---
release: <version>
from: <from>
to: <to>
source_hash: <source_hash from plan.py>
---

# Flowpad <version>

*Released <Mon D, YYYY>*

## New
- **<Area>** — <what the user can now do, one line>.

## Improved
## Fixed
## Upgrade notes
```

- Words a user knows: what changed for them, not how. No class names, routes, test names, PR jargon.
- Merge commits on the same feature into one line. Drop internal-only changes (refactors, CI, typing).
- Empty section → leave it out. `Upgrade notes` only when `migrations/<version>/` has a recipe
  (`scripts/migrate.py` or `skill/SKILL.md`) — say what it changes for the user.
- `source_hash` must be copied exactly — it is what makes the next run `fresh`.

## 3. Check

Re-run `plan.py` with the same arguments: it must print `fresh`. Never commit — the deploy script
commits the file together with the version bump.

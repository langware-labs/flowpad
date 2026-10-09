# Reuse sweep — does this already exist?

The question for every NEW symbol in the diff: *was there already code that does
this, which the change should have called or extended instead?* `simplify` and
`slick` look at the diff; this sweep looks at the **rest of the repo**.

## 1. List what the diff adds

```bash
git diff "$BASE"...HEAD -U0 | grep -E '^\+\s*(async def|def|class|export (default )?(function|const|class)|function|const [A-Z]\w* = )'
git diff "$BASE"...HEAD -U0 | grep -E '^\+.*@(router|app)\.(get|post|put|delete|patch)\('   # new routes
git diff "$BASE"...HEAD --name-only --diff-filter=A                                       # new files
```

Skip tests, private one-line helpers, and trivial accessors.

## 2. For each candidate, search by behavior — not just by name

A duplicate rarely shares a name. For each candidate, derive 2–4 search keys
from **what it does**: the domain nouns, the verb, the API it calls, a
distinctive literal it uses. Then:

```bash
rg -n --type py  -e '<key1>' -e '<key2>' flow_sdk/ ts_sdk/ -g '!**/tests/**'
rg -n --type ts  -e '<key1>' -e '<key2>' ui/src ts_sdk/src
```

Look first where flowpad's shared machinery lives (these are the usual
"it was already there" answers):

| The new code does… | Check first |
| --- | --- |
| entity lookup / find-or-create / idempotency | `Entity` classmethods, `SourceItem.find_existing`, `DataSource.find_for_account` |
| id minting | `mint_uuid`, `Entity.allocate_id`, `TypeInfo.mint_entity_id` |
| a frontend call to the backend | `dataManager`, `ActionInfo` actions, `apiClient` |
| per-type behavior / icon / label | the type's `TypeInfo` in `flow_sdk/schema/type_info/`, `iconForType()` |
| a payload / config / file-header shape | an existing `DataSpec` subclass in `flow_sdk/schema/data_spec/` |
| navigation / opening a view | `navigation.openDock(...)` and the dock loaders |
| a path / home dir / instance dir | the existing path helpers (see `slick` P8 and `.claude/skills/slick/references/anchors.md`) |
| a CLI subcommand helper | sibling files in `flow_sdk/cli/commands/` |
| a React hook / dialog / list | `ui/src/hooks/`, `ui/src/components/` siblings of the changed file |

`.claude/skills/slick/references/anchors.md` is the index of canonical
implementations — open it.

## 3. Judge

Flag only when the existing code **covers the same behavior** (≈ the same
inputs → the same result) and calling or extending it is the smaller change.
Not a finding: a superficial name match, code that would need contortions to
fit, or a deliberate fork the commit message or a comment explains.

Finding format:

```
<new file>:<line> — reuse — `<new symbol>` duplicates `<existing symbol>` (<existing file>:<line>); <call it | extend it with X>
```

Also flag the inverse: the diff **changes** a shared helper's behavior for one
caller instead of adding a parameter or a driver trait (slick P6).

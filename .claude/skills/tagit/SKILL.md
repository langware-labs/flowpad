---
id: f08b35a5-be43-479d-b6ae-254cfe086e9d
name: tagit
description: >-
  Turn a proven root cause into a durable breadcrumb. Writes the rules you
  established into a tag doc (a real wiki page) and drops a `tag` capsule on top
  of the failing test pointing at it, so the next agent to hit that test starts
  from proven ground truth instead of re-deriving it. Use AFTER an RCA has
  proven a cause with an on/off lever, or whenever a scenario is understood well
  enough to state its rules and internals. Triggers on "tagit", "capture these
  rules", "breadcrumb this test", "write this up as a tag".
tags: ''
eval: 'false'
version: 1
---

# tagit — breadcrumb capsules on failing tests

RCA proves a cause and stops, by design, with no artifact. tagit is the step that
makes the understanding survive: **rules into a tag doc, breadcrumb onto the
test.** Reading it back is the `tag-context` skill's job — you are the writer.

## Precondition — do not skip

A proven root cause with an **on/off lever** (flip it, the bug goes; flip it
back, the bug returns), or an equally well-established scenario. If what you
have is a plausible story, stop and say so. tagit does not do RCA, and a rules
doc built on a hypothesis is worse than none — everything downstream will trust
it. This is ground truth, and it changes only with the user's approval.

## The shape

| Piece | Value |
|---|---|
| tag | `breadcrumb.test.<slug>.rules` — `<slug>` is **≤3 words**, snake_case, a *topic*, not the pytest function name |
| capsule | name `tag`, on top of the failing test, one per test |
| doc | `docs/breadcrumbs/<slug>.md`, frontmatter `tags: [<tag>]` |
| fence | a ```` ```breadcrumb ```` block under `## Bound tests` — renders the bound tests as clickable chips |

The slug is a topic so a test rename does not orphan the tag. `breadcrumb` is
not a reserved root, so the tag can be blessed.

## Steps

**1 — State the rules.** Expected behavior, the internals you actually proved,
the invariant, the failure mode. Because the capsule sits only on the test, the
doc must **name the production files and symbols** (`path.py:120`, function
names) — there is no capsule at the cause site to grep for.

**2 — Create the tag.**

```bash
flow tag create breadcrumb.test.<slug>.rules --title "<title>" --description "<one line>"
```

Idempotent (`id = uuid5("tag:<name>")`). A 4xx means the name is invalid or sits
under a system-owned root — pick a different slug, never force it.

**3 — Write the doc** at `docs/breadcrumbs/<slug>.md`:

````markdown
---
title: <human title>
tags: [breadcrumb.test.<slug>.rules]
description: <one line — this is ALL that `--mode line` shows, make it carry weight>
---
# <title>

> Ground truth. Proven by RCA on <YYYY-MM-DD>. Do not edit without the user's approval.

## Expected behavior
## Internals
## Invariants
## Failure modes
## Bound tests

```breadcrumb
tag: breadcrumb.test.<slug>.rules
sites: <paste from step 4 — leave the fence out until you have it>
```
````

The `breadcrumb` fence renders as a card of the bound tests, each one a chip
that peeks at the test at its capsule's line. `sites` is the fallback it draws
before the tag index answers, so it must match the capsule exactly — which is
why step 5 hands it to you rather than you retyping it.

If the doc already exists, **diff and ask** — never overwrite a rules doc
silently.

**4 — Drop the breadcrumb.** Always through the script; never hand-write the
comment block:

```bash
python .claude/skills/tagit/scripts/insert_breadcrumb.py \
  --file tests/.../test_x.py --test <test_function> \
  --tag breadcrumb.test.<slug>.rules \
  --note "FAILING? read this tag's rules before editing" \
  --print-fence
```

The `--note` is the **entire** payload `flow tag get` shows for a code site, so
write it imperative, not descriptive. The script owns column-0 placement,
decorator and test-class hoisting, and merging into an existing breadcrumb — all
of which fail *silently* when done by hand (an indented or duplicated block
removes the whole file from `flow tag get` with no error anywhere).

`--print-fence` emits the doc's ```breadcrumb block, already carrying the line
it just wrote. **Paste it verbatim** into the doc's `## Bound tests` section.
Retyping it by hand is how the capsule and the card drift apart — the same
reason the capsule itself goes through the script.

**5 — Index it**, or it stays invisible to `flow tag get`:

```bash
flow record index docs/breadcrumbs/<slug>.md
```

Index *after* the fence is pasted, not before — otherwise the indexed body is
the one without it.

**6 — Prove the chain.**

```bash
flow tag get breadcrumb.test.<slug>.rules --root .
```

Must show **1 doc** and the **code site at the test's line**. Anything less and
the breadcrumb does not exist as far as the next agent is concerned. This also
catches this repo's background `git stash`/pull/pop reverting your edits.

**7 — Show it, link it, and ask.**

```bash
flow show file docs/breadcrumbs/<slug>.md
flow record url docs/breadcrumbs/<slug>.md
```

`show` sets the display focus for *this process's* watchers; `url` prints the
link for the *human* — different audiences, so run both. Paste the `url` field
into your reply so the user can click straight to the doc.

Failure modes, in order of likelihood: `show` exits 2 (`NO_PROCESS`) outside a
Flowpad worker; `url` exits 4 with `NOT_INDEXED` if you skipped step 5, or
`NO_ASSET_EDITOR` for a type with no editor; either exits 5 when the backend is
down. On any of them, just print the path.

Showing is not approval: ask the user to review the rules explicitly.

## Rules

* **User-invoked only.** Never chain yourself onto an RCA.
* **The doc is ground truth, not a log.** No dated append-only entries; revise
  the rules in place, with approval.
* **Do not touch toplog.** `toplog learn` grows the *trace* catalog (what to
  log). tagit writes *design rules* (what must be true). Different vocabularies,
  different files — do not cross them.

## Reference

| Need | Where |
|---|---|
| how the tag system binds docs and code | `docs/tags.md` |
| how the `breadcrumb` fence renders and refreshes | `docs/renderable-fences.md` |
| capsule carriers, grammar, repeatable names | `docs/data-management/asset-capsules.md` |
| reading a tag back | the `tag-context` skill |

---
id: f08b35a5-be43-479d-b6ae-254cfe086e9d
name: tagit
description: ''
tags: ''
eval: 'false'
version: 2
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

| Piece   | Value                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| tag     | `breadcrumb.test.<slug>.rules` — `<slug>` is **≤3 words**, snake\_case, a *topic*, not the pytest function name |
| capsule | name `tag`, on top of the failing test, one per test                                                            |
| doc     | `docs/breadcrumbs/<slug>.md`, frontmatter `tags: [<tag>]`                                                       |
| fence   | a ` ```breadcrumb ` block at the TOP of the doc — renders the bound tests as clickable chips                    |

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

```breadcrumb
tag: breadcrumb.test.<slug>.rules
sites: <paste from step 4 — leave the fence out until you have it>
```

## Expected behavior
## Internals
## Invariants
## Failure modes
````

The fence renders as a card of bound tests, each a chip that peeks at its test
at the capsule's line. It sits at the top because whoever opens this doc arrived
from a failing test: the way back to it should be the first thing on screen, and
prose below a card still reads in order.

`sites` is the fallback the card draws before the tag index answers, so it must
match the capsule exactly — which is why step 4 hands it to you rather than you
retyping it.

If the doc already exists, **diff and ask** — never overwrite a rules doc
silently.

**4 — Drop the breadcrumb.** Always through the script; never hand-write the
comment block:

```bash
python "<this skill's directory>/scripts/insert_breadcrumb.py" \
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

`--print-fence` emits the doc's \`\`\`breadcrumb block, already carrying the line
it just wrote. **Paste it verbatim** at the top of the doc, under the banner.
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

**8 — Share it, only if the user asks for a reviewer link.**

```bash
flow record share docs/breadcrumbs/<slug>.md --with tests/.../test_x.py
```

Commits **exactly those two paths** (never `git add -A` — this repo is a shared
checkout), pushes the branch, registers the doc with the cloud, and prints a
`url` a reviewer can open. Paste that `url` into your reply.

The `--with` is not optional in practice: the capsule is an edit to a *test
file*, and a rules doc whose bound test isn't in the same commit tells a
reviewer half the story.

**Never pass** **`--link-project`.** If the project isn't linked to the cloud the
command exits **3**, mutates nothing, and returns `remediation` — print those
lines and stop. Linking publishes a repo declaration to every member of the
project; that is the user's decision, not yours. What it does and does not
upload is [docs/collab/cloud-sharing.md](../../../docs/collab/cloud-sharing.md).

Exit codes: **3** = a gate the user can fix, nothing was touched; **4** =
not indexed / no owning project; **7** = the commit, push or registration
itself failed. Only 7 means something is broken.

## Rules

* **User-invoked only.** Never chain yourself onto an RCA.

* **The doc is ground truth, not a log.** No dated append-only entries; revise
  the rules in place, with approval.

* **Do not touch toplog.** `toplog learn` grows the *trace* catalog (what to
  log). tagit writes *design rules* (what must be true). Different vocabularies,
  different files — do not cross them.

## Reference

| Need                                             | Where                                    |
| ------------------------------------------------ | ---------------------------------------- |
| how the tag system binds docs and code           | `docs/tags.md`                           |
| how the `breadcrumb` fence renders and refreshes | `docs/renderable-fences.md`              |
| what cloud sharing does and does not upload      | `docs/collab/cloud-sharing.md`           |
| capsule carriers, grammar, repeatable names      | `docs/data-management/asset-capsules.md` |
| reading a tag back                               | the `tag-context` skill                  |

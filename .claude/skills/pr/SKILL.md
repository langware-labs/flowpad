---
id: e95ff104-3ba7-4cd1-8f41-a8fbf93312c6
name: pr
description: 'Pre-PR quality gate for the flowpad repo — one report that answers "is
  this branch ready for a PR?". Orchestrates the existing lenses (slick check for
  architecture, code-review for bugs, security-review, flowpad-api-urls, docit) over
  the branch diff, runs the policy tests and linters, and adds the checks no other
  skill does: a reuse sweep (does code like this already exist?), a test-integrity check (did an edited test stop guarding its behavior?), a cross-repo
  check (does the change break the other of flowpad / flowpad-hub?) and the CLAUDE.md
  rules that have no test. `pr` / `pr review [target]` reports only; `pr open` reviews,
  then prepares the PR and waits for approval before every git step. Triggers on "review
  my branch before a PR", "is this ready to merge", "pr check", "open a PR", or "/pr".'
---

# PR — the pre-PR quality gate

This skill **orchestrates; it does not re-implement.** Each dimension already
has an owner — run it and fold its findings into one report. Only the reuse
sweep, the test-integrity check, the cross-repo check and the untested CLAUDE.md rules are this skill's own work.

**Which repo.** This folder lives in `flowpad` and is symlinked into
`flowpad-hub/.claude/skills/pr`. Run against the repo you're in: its own
`CLAUDE.md` is the rulebook, and its own test tree holds the policy tests
(`flowpad`: `tests/unit/`; `flowpad-hub`: `flowpad/hub/tests/`). The paths in
`references/` are written for `flowpad`. In the hub, apply the rules whose code
exists there and skip the rest. The two repos talk to each other, so a change in
one may need a look at the other — see the cross-repo lens in step 3.

## Modes (from the skill arg)

| Skill arg | What it does |
| --- | --- |
| *(none)*, `review`, or `review <PR# \| branch \| commit-range \| path>` | Steps 1–4. Report only — never edits, never touches git state. In an E2B sandbox on a PR, also step 5 (post the review and approve) |
| `open` | Steps 1–4, then `references/open.md` — every git step gated on explicit approval |
| `fix` | Steps 1–4, then apply the CONFIRMED findings the user picks, then re-run step 2 on the touched files |

## Step 1 — Scope

Default target is the branch against its base:

```bash
BASE=$(git branch -r | grep -oE 'origin/release/v0\.[0-9]+' | sort -V | tail -1)
git fetch -q origin "${BASE#origin/}"
git diff --stat "$BASE"...HEAD; git status --short   # include uncommitted + untracked
```

A `PR#` → `gh pr diff <n>`. State the scope in one line at the top of the
report (base, commits, files changed). If the diff is empty, say so and stop.

## Step 2 — Mechanical gates (run in the background, in parallel)

Never the whole unit tier. Run only:

* **Policy tests** — every `tests/unit/test_*{policy,guard,self_contained}*.py`
  plus `tests/unit/test_no_*.py`. Collect them with `find` and pass them through
  `$(... | tr '\n' ' ')`, never as a stored `$VAR`. zsh does not word-split an
  unquoted variable, so pytest gets one bogus path and reports "no tests ran",
  which looks like a pass:
  `uv run pytest -q $(find tests/unit -maxdepth 1 \( -name 'test_*policy*.py' -o -name 'test_*guard*.py' -o -name 'test_*self_contained*.py' -o -name 'test_no_*.py' \) | tr '\n' ' ')`.
  "no tests ran" is a failed gate, not a pass. These already enforce entity-id policy, data
  source self-containment, no machine-wide state, etc. — a rule a test owns is
  NOT re-checked by hand in step 3.
* **Tests next to the change** — the test files whose module or name matches a
  changed file (`git diff --name-only` → find the matching `tests/**/test_<stem>*.py`
  / `ui/tests/**/<Stem>*.test.ts`). A new dock view type needs its row in
  `ui/tests/unit/dock-loader/dock-loader-matrix.test.ts`.
* **Lint** — `uv run ruff check <changed .py>`; `cd ui && npx eslint <changed .ts/.tsx>`
  (root `tsc --noEmit` checks nothing — eslint is the gate, including Lingui
  macro imports).

A failing gate is a finding of severity **blocker**. Never raise a timeout or
add a retry to get a gate green (CLAUDE.md).

## Step 3 — Lenses (fan out in parallel; each returns findings with `file:line`)

| Dimension | Owner | How to run it |
| --- | --- | --- |
| Architecture / layer placement | `slick` | `slick check` on the scope |
| Correctness bugs | `code-review` | at `high` on the scope |
| Security | `security-review` | on the scope, then `references/rules.md` § Security for the flowpad-specific items |
| API URL shape | `flowpad-api-urls` (lives only in `flowpad-hub/.claude/skills/` — from `flowpad`, read it there) — its "Reviewing a diff" checklist | only when the diff adds or changes a route, an `@action`, an `apiClient`/`hub_post` call, or a URL string. A new router is fine only for a public / external-shape / special-transport endpoint, per the skill's "When a router is right"; a signed-in router for entity work is a blocker |
| Docs agree with code | `docit` | on the scope — report-only here, don't let it edit docs in `review` mode |
| **Reuse — does this already exist?** | **this skill** | `references/reuse.md` |
| **CLAUDE.md rules with no test** | **this skill** | `references/rules.md` |
| **Cross-repo — does the other repo (flowpad ↔ flowpad-hub) need to change too?** | **this skill** | `.claude/pr-cross-repo.md` in the `flowpad-hub` checkout (private — the guide stays there). Find the checkout: the repo you're in, `../flowpad-hub`, `~/Developer/flowpad-hub`, or this session's `--add-dir` folders. Not found → skip and say so |
| **Test integrity — did an edited test stop guarding its behavior?** | **this skill** | `references/test-integrity.md` — only when the diff modifies or deletes an existing test |
| **Windows & Unix compatibility** | **this skill** | `references/cross-platform.md` — paths, OS-only APIs, lines typed into a shell |

Delegate each lens to a subagent when the diff is large; give it the scope from
step 1 and the lens's own output contract. Skip a lens the diff can't touch
(no UI files → skip the frontend half of rules.md) and say you skipped it.

The whole review waits for the slowest lens, and that is the correctness lens
(`code-review` + `security-review`) on a large diff. When the diff spans more than
one area (backend `flow_sdk/` + `electron/`, or backend + `ui/`/`ts_sdk/`), split
that lens into **one subagent per area**, all launched in the same message. Each
gets only its own area's files plus read access to the rest for context, and
reports cross-area contract mismatches (a file one side writes and the other
reads) from its own side.

## Step 4 — Verify, then one report

Before reporting, **verify every finding** by reading the cited lines: drop it
if the code doesn't say what the finding claims, or if a test from step 2
already covers it. Mark the survivors CONFIRMED (seen in code) or PLAUSIBLE
(needs a run to prove). Dedupe across lenses — one issue, one line, credit the
first owner.

Write the report to the session scratchpad as `pr-report.md` (not in the repo),
show it with `flow show file <path>`, and summarize in chat:

```
PR check — <branch> → <base> · <N commits, M files>
Verdict: READY | READY WITH NITS | NOT READY (<k> blockers)

Blockers      (failing gate, bug, security hole, broken CLAUDE.md rule)
1. <file>:<line> — <dimension> — <the problem in ≤15 words> [CONFIRMED]
Should fix    (duplicated code, wrong layer, URL shape, stale doc)
2. …
Nits          (only if few; otherwise "k nits — see report")

Gates: policy tests <pass/fail>, related tests <pass/fail>, ruff <…>, eslint <…>
Skipped: <lens — why>
```

Significance bar: no formatting, naming taste, or speculative "could maybe"
items. A clean dimension is one line ("Reuse: clean"), not a paragraph.

## Step 5 — In a sandbox: post the review and approve

Only when running in an E2B sandbox (`[ -n "$E2B_SANDBOX" ]`) and the target is
a PR (`PR#`, or a branch that has an open PR — `gh pr view --json number`).
Anywhere else, skip this step: the report stays report-only.

**Always approve, whatever the verdict — even with blockers.** The findings are
the review's content; the approval is not a verdict on them. Post both in one
review:

```bash
gh pr review <n> --approve --body-file <scratchpad>/pr-report.md
```

Run it from the repo the PR belongs to (`flowpad` or `flowpad-hub`). If GitHub
refuses the approval (e.g. the token's user is the PR's author), post the report
with `gh pr review <n> --comment --body-file …` instead and say in chat why it
wasn't approved. Never retry with a different account.

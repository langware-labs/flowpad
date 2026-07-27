---
id: 991ce9be-3ec0-4bd4-89c1-7e18d9b438e5
name: docit
description: Doc-consistency lens — check the session's code changes against the
  repo docs (no contradictions, no broken arch requirements) and bring the docs
  up to date with what actually changed.
tags: ''
version: 1
---

# Docit — keep code and docs in agreement

Docit runs over the **changes of the current session** (working tree + branch
commits, or an explicitly given diff/commit range) and does two passes against
the repo's documentation:

1. **Contradiction pass** — did the change break anything the docs declare?
   Architectural requirements are binding until the user says otherwise.
2. **Freshness pass** — do the docs still tell the truth after this change?
   Update them so the next reader isn't misled.

Docit never rewrites code. Code violations are *reported*; only docs are edited.

## Scope resolution (do this first)

1. Determine the change set, in priority order:
   * an explicit arg (`docit <commit-range | path | PR#>`) → that diff;
   * otherwise the session's work: `git diff` (staged + unstaged) **plus**
     commits on the current branch not on `main`
     (`git log main..HEAD --oneline`; use `git diff main...HEAD` for content).
2. If the change set is empty, say so and stop.
3. Bucket changed files by subsystem (backend `flow_sdk/…`, frontend `ui/…` +
   `ts_sdk/…`, tests, skills, docs themselves).

## Doc corpus (what to check against)

Authoritative sources, in descending strictness:

| Tier | Source | Meaning |
| ---- | ------ | ------- |
| 1 — non-negotiables | repo-root `CLAUDE.md` (sections marked *non-negotiable*), `docs/CLAUDE.md` (Record System Requirements) | Binding architecture law. A violation is a **finding**, never a doc edit. |
| 2 — subsystem specs | `docs/**/*.md` — route via `docs/index.md` and per-folder `index.md` (e.g. `docs/data-management/`, `docs/collab/`, `docs/tabs/`) | Design contracts. A mismatch is either a code bug or an intentional change that must be reflected in the doc. |
| 3 — root-level design notes | `AgentApi.md`, `contextProcess.md`, `DESIGN_*.md`, `capabilities.md`, etc. | Descriptive; update freely when stale. |

Select **relevant** docs only: match changed paths/symbols against doc titles,
`docs/index.md` summaries, and grep for the touched module/function/entity-type
names inside `docs/`. Do not read the whole corpus — read what the diff touches.

## Pass 1 — contradiction / arch-requirement check

For each changed file, against its relevant tier-1/tier-2 docs, verify the
change does not:

* violate a stated invariant (e.g. entity ids not minted via `mint_uuid`,
  edge fields added to `metadata.json`, a hardcoded backend URL in the
  frontend, a raised timeout, `state.json`-style caching reintroduced,
  optimistic dataContext writes in click handlers);
* contradict a documented flow, layout, or contract (record shadow-folder
  layout, sentinel semantics, URL-first navigation, envelope shape, …);
* silently change behavior a doc promises to callers (API shape, event
  ordering, freshness/orphan semantics).

Rules:

* A tier-1 violation is always reported as **BLOCKER**; never "fix" it by
  editing the doc, and never patch the code yourself — report it.
* A tier-2 mismatch: decide from the session context whether the change is
  intentional. Intentional → it's a freshness item (pass 2). Unintentional or
  unclear → report as **CONTRADICTION** and ask nothing — flag it with the
  exact doc sentence vs. the exact code line, and let the user rule.
* Every finding cites both sides: `doc-file:line` (the promise) and
  `code-file:line` (the breach). No finding without both citations.

## Pass 2 — doc freshness update

For each relevant doc, check whether the change made any statement stale:
renamed/moved files or symbols, changed defaults, added/removed flags or
endpoints, new behavior a doc's flow description should include.

Rules for edits:

* Integrate in place — rewrite the sentence/section so the doc reads as if it
  had always been correct. No changelogs, no "as of <date>" bullets, no
  appended "Update:" sections.
* Match the doc's existing voice, depth, and formatting.
* Update only what the diff made stale — docit is not a doc-rewrite pass.
* If the change introduces a genuinely new subsystem/contract with no home in
  `docs/`, propose (don't create unasked) a new doc: give the suggested path
  and a 3–5 line outline in the report.
* Never edit generated frontmatter (`id`, `inputs_hash`, `generated_at`, …) in
  index files; body text only. Never change a doc's `id:`.

## Report (always, and last)

End with a single report, in this order:

1. **Verdict line** — `CLEAN`, or `N blockers / M contradictions / K docs updated`.
2. **Blockers** (tier-1 violations) — doc cite vs code cite, one line each + a
   sentence on the mechanism.
3. **Contradictions** (tier-2, unresolved) — same format.
4. **Doc updates applied** — file → one-line summary of what was corrected.
5. **Proposed new docs** — path + outline (if any).

If nothing was found and nothing was stale, say `CLEAN` and stop — no filler.

## Ground rules

* Docs are evidence, code is evidence; docit's job is to make them agree —
  the user's intent decides which side wins at tier 2, the docs always win at
  tier 1.
* Never widen scope to files outside the change set "while you're there".
* At most ~8 doc files edited per run; if more are stale, edit the most
  load-bearing ones and list the rest in the report.

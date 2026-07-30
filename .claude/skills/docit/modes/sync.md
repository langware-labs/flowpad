# Mode: `sync` (default) — make the docs agree with the code

> Ground rules (inline by design): docit never rewrites code — code violations are
> reported, never patched; only docs are edited. Integrate edits in place (no
> changelogs, no "as of \<date>" bullets, no appended "Update:" sections). Never
> edit generated frontmatter (`id`, `inputs_hash`, `generated_at`) and never change
> a doc's `id:`. Never widen scope beyond the change set. At most ~8 doc files
> edited per run.

Sync runs over the **changes of the current session** (working tree + branch
commits, or an explicitly given diff/commit range) and does two passes against
the repo's documentation:

1. **Contradiction pass** — did the change break anything the docs declare?
   Architectural requirements are binding until the user says otherwise.
2. **Freshness pass** — do the docs still tell the truth after this change?
   Update them so the next reader isn't misled.

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

Tier-2 routing depends on the `index.md` chain being real. If a folder you need
has no `index.md`, or the summaries you're routing by look wrong, fall back to
grep for this run and note it — then `index fast` (`modes/index.md`) will tell
you whether the chain is stale.

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

Rules for edits (on top of the ground rules above):

* Match the doc's existing voice, depth, and formatting — the rewritten sentence
  should read as if it had always been correct.
* Update only what the diff made stale — docit is not a doc-rewrite pass.
* If the change introduces a genuinely new subsystem/contract with no home in
  `docs/`, propose (don't create unasked) a new doc: give the suggested path
  and a 3–5 line outline in the report.
* A doc carrying `ground_truth: true` is hand-written and authoritative — edit
  its prose like any other doc, but never treat it as a generated index and
  never strip that flag.

Editing a doc's body changes its content hash, which stales its folder's
`index.md`. That's expected; sync does not rebuild the chain. Mention it in the
report so the user can run `index` when they want the map caught up.

## Report (always, and last)

End with a single report, in this order:

1. **Verdict line** — `CLEAN`, or `N blockers / M contradictions / K docs updated`.
2. **Blockers** (tier-1 violations) — doc cite vs code cite, one line each + a
   sentence on the mechanism.
3. **Contradictions** (tier-2, unresolved) — same format.
4. **Doc updates applied** — file → one-line summary of what was corrected.
5. **Proposed new docs** — path + outline (if any).

If nothing was found and nothing was stale, say `CLEAN` and stop — no filler.

## Arbitration

Docs are evidence, code is evidence; docit's job is to make them agree — the
user's intent decides which side wins at tier 2, the docs always win at tier 1.

When more than ~8 doc files are stale, edit the most load-bearing ones and list
the rest in the report rather than exceeding the cap.

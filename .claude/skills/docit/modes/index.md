# Mode: `index [fast|full] [<root>]` — reconcile the docs' navigation layer

> Ground rules (inline by design): docit never rewrites code — code violations are
> reported, never patched; only docs are edited. Integrate edits in place (no
> changelogs, no "as of \<date>" bullets, no appended "Update:" sections). Never
> edit generated frontmatter (`id`, `inputs_hash`, `generated_at`) and never change
> a doc's `id:`. Never widen scope beyond the change set. At most ~8 doc files
> edited per run.

`sync` checks what the docs *say*; `index` checks the `index.md` chain they are
*reached through* — the per-folder Merkle index that `sync`'s tier-2 routing and
the `docs-browse` skill both navigate. A stale chain silently misroutes every
reader.

`<root>` defaults to `docs`. A sub-tree is allowed (`index full docs/tabs`) and is
the cheap way to validate a change — but note it is scanned as its own root, so an
*ancestor* `.gitignore` is not loaded and its hashes are relative to that root: a
sub-tree rebuild does **not** update the parent's `index.md`.

Bare `index` means `fast`. `full` writes into the docs tree and costs real LLM
calls, so it must be asked for by name.

Use `python3` or `uv run python` — never bare `python`.

## `fast` — audit only. No LLM, no writes.

```bash
python3 .claude/skills/docit/scripts/docs_index_report.py docs
```

Reports counts, then four lists: **missing** (folders with no `index.md`),
**stale** (on-disk `inputs_hash` ≠ recomputed), **would clobber** (an `index.md`
with no `inputs_hash` — hand-written, so a rebuild would overwrite it), and
**protected** (`ground_truth: true` / `manual: true`). `uncached` is the
file-summary LLM-call estimate for `full`.

Report the verdict and stop. `fast` never writes — if the chain is stale, say so
and let the user decide whether to spend a `full`.

There is deliberately no cheap write path: a rebuild with a cold summary cache
would emit empty summaries into the docs tree. A no-LLM "refresh" is not a thing
this mode offers.

## `full` — the real rebuild

The rebuild protocol is the `markdown_index` skill's, and it is not restated here
— **load `markdown_index/SKILL.md` and follow its Protocol** (planner → you
summarize → renderer; post-order; never recompute `inputs_hash`; never hand-write
the `.md`; `manual: true` is skipped).

Two things are docit's, and they wrap that protocol:

**Before.** Resolve the cache and clear the guard.

```bash
ROOT=$(python3 -c "from pathlib import Path; print(Path('docs').resolve())")
REPORT=.claude/skills/docit/scripts/docs_index_report.py
SUMMARIES_DIR=$(python3 "$REPORT" "$ROOT" --print-summaries-dir)   # never re-derive it
mkdir -p "$SUMMARIES_DIR"

python3 "$REPORT" "$ROOT"        # never start `full` without this
```

Non-empty **would clobber** → STOP and ask. The fix is `ground_truth: true` in
that file's frontmatter, never a rebuild over it. Otherwise state the LLM-call
estimate before spending it.

**During.** One extra invariant on top of the protocol's: **never force past a
protect flag.** `ground_truth: true` and `manual: true` are the planner's opt-out;
a protected folder that looks wrong is a conversation, not a rebuild. `plan.py
--force` re-summarizes unchanged content — pass it only on explicit request.

Then hand the planner the dir you just resolved:

```bash
python3 flow_sdk/system_projects/flowpad_assistant/.claude/skills/markdown_index/plan.py \
  build "$ROOT" --summaries-dir "$SUMMARIES_DIR"
```

Both plan lists empty → `INDEX FRESH (N folders, 0 stale)` and stop. Otherwise
finish where `markdown_index` finishes: `INDEX UPDATED: <F> files re-summarised,
<K> folders re-assembled.`

## Reference

| When you need… | Load |
| -------------- | ---- |
| the rebuild protocol, prompt wording, and its rationale | `flow_sdk/system_projects/flowpad_assistant/.claude/skills/markdown_index/` (repo) |
| the IndexMdJson field list the sidecar must satisfy | `flow_sdk/fs_store/operations/markdown_index_render.py` (repo) |

"""The ``sample-context-git`` repository: a shareable context folder.

A git repo carrying 35 assets across every type a **context folder** can
contribute, used to exercise the whole path end to end — detect a git origin,
link it as a shared context folder, clone it on another machine, index it, and
see its assets accumulate into the project's Assets menu.

Type selection is not arbitrary. A project's own mount is walked as
``REAL_PROJECT_CWD``, but a context folder is walked as ``CWD_ROOT`` by
``_index_additional_dir``, and the two root types have different walkers
registered (``flow_sdk/fs_store/indexer/builtin.py``). Every type below is
registered on ``CWD_ROOT`` **and** browseable, so all 35 assets are reachable
from a context folder. ``prompt`` is deliberately absent — it is
``REAL_PROJECT_CWD``-only and would silently count zero here.

The same manifest drives the local `file://` test and the real GitHub repo, so
whatever the test asserts is exactly what a user cloning the repo gets.
"""

from __future__ import annotations

# What the generator writes, named so the repo reads like something a person
# made. The NAMES are the declaration and the counts derive from them, so there
# is nothing to keep in sync and no runtime guard reconciling two lists.
#
# `spec` is deliberately absent: its record carries embedded blob storage, which
# needs a request context to save, so indexing one from a plain directory walk
# fails (`get_embedded_storage: No parent_storage`). Shipping a type that
# silently fails to index would make the repo lie.
SAMPLE_ASSET_NAMES: dict[str, tuple[str, ...]] = {
    "skill": ("changelog-writer", "commit-splitter", "dep-auditor", "flaky-finder", "perf-profiler", "test-namer"),
    "subagent": ("api-reviewer", "docs-editor", "migration-planner", "release-captain", "schema-checker", "triage-bot"),
    "markdown": (
        "architecture", "code-review-guide", "data-model", "glossary",
        "onboarding", "release-process", "style-guide", "troubleshooting",
    ),
    "task": ("audit-dependencies", "cut-release", "harden-error-paths", "raise-coverage", "trim-cold-start"),
    "plan": ("auth-rework", "cache-layer", "observability", "search-rollout"),
    "claude_rules": ("commit-style", "no-secrets-in-logs", "test-first"),
    "whiteboard": ("request-lifecycle", "service-map"),
}

AUTHORED_ASSETS: dict[str, int] = {t: len(names) for t, names in SAMPLE_ASSET_NAMES.items()}

# What the MENU reports, which is one more markdown than we authored: README.md
# sits at the repo root and is itself a document, so the indexer counts it.
# (`.claude/plans` and `.claude/rules` are NOT counted as markdown — the walk
# skips dot-directories — which is why only the README shows up here.)
SAMPLE_CONTEXT_ASSETS: dict[str, int] = {
    **AUTHORED_ASSETS,
    "markdown": AUTHORED_ASSETS["markdown"] + 1,
}

SAMPLE_CONTEXT_TOTAL = sum(SAMPLE_CONTEXT_ASSETS.values())

SAMPLE_REPO_NAME = "sample-context-git"

README = """# sample-context-git

A sample **context folder** for [Flowpad](https://github.com/serans1/flowpad) — a
git repository you can attach to any project to lend it a ready-made set of
assets.

## What a context folder is

A Flowpad project can point at directories outside its own tree. Their assets —
skills, agents, docs, tasks — show up in the project's Assets menu and are
mounted for agentic sessions, without being copied into the project. When the
directory is a git repository, the link is **transportable**: sharing the project
sends the repo coordinates, and the person on the other end clones it rather than
receiving a pile of bytes. That is what this repository is for.

## What is in here

{manifest}

**{total} assets in total.** The mix is deliberate: these are exactly the types a
context folder can contribute. A project's own folder is indexed as a project
root, but a context folder is indexed as a plain directory root, and the two
resolve different asset types. Everything here is reachable from either.

One of the documents is this README: it sits at the repository root and the
indexer counts it like any other `.md`.

## Layout

Each type lives where Flowpad's indexer looks for it — the same layout any
Flowpad project uses:

```
.claude/skills/<name>/SKILL.md      skills
.claude/agents/<name>.md            sub-agents
.claude/plans/<name>.md             plans
.claude/rules/<name>.md             rules
.claude/whiteboards/<name>/         whiteboards (WHITE_BOARD.md + board.json)
agentic-assets/task/<name>/task.md  tasks
docs/<name>.md                      documents
```

The contents are placeholders. This repository exists to exercise and demonstrate
the *plumbing* — discovery, counting, sharing, cloning — not to be useful reading.

## Using it

In Flowpad: **Context folders → +**, and point at a clone of this repository.
Because it has a git origin it can be attached with **shared** scope, so anyone
you share the project with gets it too.

Your clone will show modified files after Flowpad first indexes it: the indexer
stamps each asset with an identity capsule so the asset keeps its identity as it
moves. That is expected, and those ids are deliberately *not* committed here —
if they were, two clones of this repository on one machine would share ids and
the second would dedup against the first instead of counting its own assets.

## Regenerating

This repository is generated, not hand-maintained:

```
uv run python scripts/make_sample_context_repo.py <target-dir>
```

The manifest above is the single source of truth, in
`tests/fixtures/sample_context_repo.py`. The end-to-end test that pins it is
`tests/unit/test_sample_context_repo.py`.
"""


def readme_text() -> str:
    """The README, with the manifest rendered from the one manifest."""
    labels = {
        "skill": "skills",
        "subagent": "sub-agents",
        "markdown": "documents",
        "task": "tasks",
        "plan": "plans",
        "claude_rules": "rules",
        "whiteboard": "whiteboards",
    }
    rows = "\n".join(
        f"| {labels.get(t, t)} | {n} |" for t, n in sorted(SAMPLE_CONTEXT_ASSETS.items(), key=lambda kv: -kv[1])
    )
    manifest = f"| type | count |\n| --- | --- |\n{rows}"
    return README.format(manifest=manifest, total=SAMPLE_CONTEXT_TOTAL)

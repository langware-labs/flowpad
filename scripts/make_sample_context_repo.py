#!/usr/bin/env python3
"""Generate the ``sample-context-git`` repository.

Writes the README plus the 35 assets declared in
``tests/fixtures/sample_context_repo.py`` into a directory, and (unless
--no-git) initialises a git repo with one commit.

    uv run python scripts/make_sample_context_repo.py /tmp/sample-context-git

The manifest is the single source of truth: the local `file://` test and the
published GitHub repo are generated from it, so they cannot drift.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.fixtures.asset_tree import _write_asset  # noqa: E402
from tests.fixtures.sample_context_repo import (  # noqa: E402
    AUTHORED_ASSETS,
    SAMPLE_CONTEXT_TOTAL,
    readme_text,
)

# A name per asset, so the repo reads like something a person made rather than
# thing1..thing35. Length must be >= the count declared for each type.
NAMES: dict[str, list[str]] = {
    "skill": ["changelog-writer", "commit-splitter", "dep-auditor", "flaky-finder", "perf-profiler", "test-namer"],
    "agent": ["api-reviewer", "docs-editor", "migration-planner", "release-captain", "schema-checker", "triage-bot"],
    "markdown": [
        "architecture", "code-review-guide", "data-model", "glossary",
        "onboarding", "release-process", "style-guide", "troubleshooting",
    ],
    "task": ["audit-dependencies", "cut-release", "harden-error-paths", "raise-coverage", "trim-cold-start"],
    "plan": ["auth-rework", "cache-layer", "observability", "search-rollout"],
    "claude_rules": ["commit-style", "no-secrets-in-logs", "test-first"],
    "whiteboard": ["request-lifecycle", "service-map"],
}


def write_repo(target: Path) -> dict[str, int]:
    target.mkdir(parents=True, exist_ok=True)
    (target / "README.md").write_text(readme_text(), encoding="utf-8")
    # The indexer writes identity capsules back into the tree; keeping them
    # untracked would leave every clone permanently dirty.
    (target / ".gitignore").write_text(".flow/\n", encoding="utf-8")

    written: dict[str, int] = {}
    for type_name, count in AUTHORED_ASSETS.items():
        names = NAMES[type_name]
        if len(names) < count:
            raise RuntimeError(f"{type_name}: need {count} names, have {len(names)}")
        for name in names[:count]:
            _write_asset(target, type_name, name)
        written[type_name] = count
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("target", type=Path, help="directory to generate the repo into")
    ap.add_argument("--no-git", action="store_true", help="write files only, do not init/commit")
    ap.add_argument("--force", action="store_true", help="generate into a non-empty directory")
    args = ap.parse_args()

    target = args.target.expanduser().resolve()
    if target.exists() and any(target.iterdir()) and not args.force:
        print(f"{target} is not empty — pass --force to generate into it anyway", file=sys.stderr)
        return 1

    written = write_repo(target)
    for type_name, count in sorted(written.items(), key=lambda kv: -kv[1]):
        print(f"  {type_name:<14} {count}")
    print(f"  {'authored':<14} {sum(written.values())} files")
    print(f"  {'menu reports':<14} {SAMPLE_CONTEXT_TOTAL} assets (README.md counts as a document)")

    if not args.no_git:
        def git(*a: str) -> None:
            subprocess.run(["git", *a], cwd=target, check=True, capture_output=True, text=True)

        if not (target / ".git").exists():
            git("init", "-q", "-b", "main")
        git("add", "-A")
        # Only commit when there is something to commit, so re-running is safe.
        if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=target).returncode != 0:
            git("commit", "-qm", f"{SAMPLE_CONTEXT_TOTAL} sample context assets")
        print(f"\ngit repo ready at {target}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

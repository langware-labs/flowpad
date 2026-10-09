"""Gate: ONE git-conflict flow, end to end.

Every sync that can leave a working tree mid-merge goes through ``GitRepo``
(push/pull), which is the only conflict detector. Every UI surface toasts the
result through ``lib/git-outcome.ts``, the only builder of the Resolve action,
and ``notifications/commands.ts`` is the only launcher of the resolver prompt.

A second detector, a second merge-pull, or a second Resolve is how the two
diverging conflict toasts happened — this fails before one lands.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "flow_sdk"
UI = ROOT / "ui" / "src"
GIT_REPO = SDK / "builtin" / "faas" / "git_repo.py"


def _py_sources():
    for path in SDK.rglob("*.py"):
        if path != GIT_REPO and "system_projects" not in path.parts:
            yield path, path.read_text(encoding="utf-8", errors="replace")


def _offenders(pattern: str) -> list[str]:
    rx = re.compile(pattern)
    return [
        f"{path.relative_to(ROOT)}:{n}"
        for path, text in _py_sources()
        for n, line in enumerate(text.splitlines(), 1)
        if rx.search(line)
    ]


def test_only_git_repo_detects_a_conflict():
    assert _offenders(r"ls-files.{0,8}--unmerged|diff-filter=U|\"CONFLICT\" in|'CONFLICT' in") == []


def test_only_git_repo_runs_a_pull_that_can_conflict():
    # A fast-forward-only pull cannot leave a conflict; anything else must be GitRepo.pull().
    offenders = [o for o in _offenders(r"[\"']pull[\"']\s*,") if "--ff-only" not in _line(o)]
    assert offenders == []


def _line(offender: str) -> str:
    rel, n = offender.rsplit(":", 1)
    return (ROOT / rel).read_text(encoding="utf-8").splitlines()[int(n) - 1]


def _ui_files_mentioning(needle: str) -> set[str]:
    return {
        str(p.relative_to(UI)) for p in UI.rglob("*.ts*") if needle in p.read_text(encoding="utf-8", errors="replace")
    }


def test_only_git_outcome_builds_the_resolve_action():
    assert _ui_files_mentioning("command: 'git.resolve-conflict'") == {"lib/git-outcome.ts"}


def test_only_the_command_launches_the_resolver_prompt():
    assert _ui_files_mentioning("gitResolvePrompt(") == {"lib/git-resolve-prompt.ts", "notifications/commands.ts"}

"""Every place that starts ``git`` by itself is either guarded or a choice the person made.

On a Mac without Apple's Command Line Tools, ``/usr/bin/git`` is a stub that opens a system "install the developer
tools" dialog. Code that runs git in the background (a probe, a poll, a first-start default) must therefore ask
``git_usable()`` first; code that runs because the person asked for Git (clone, share, a git data source) may not.

This scans ``flow_sdk`` for DIRECT spawns of git: ``subprocess.*`` / ``asyncio.create_subprocess_*`` /
``os.system`` with ``git`` as the program, and a compute node ``run_command("git ...")``. Calls that go through
``utils.git._run_git`` or a command executor are not listed: those funnels are guarded once, centrally, and
``test_git_usable.py`` proves it. A new direct spawn fails here until it is guarded (the file mentions
``git_usable``) or added to ``USER_CHOSEN`` with the reason.
"""

import ast
import re
from pathlib import Path

SDK = Path(__file__).resolve().parents[2] / "flow_sdk"

#: Direct spawns that exist because the person chose Git. The reason is the point of the entry.
USER_CHOSEN = {
    "builtin/faas/compute_node.py": "delivering a shared project tree onto this node: the tree carries its own .git",
    "system_projects/flowpad_assistant/agentic-assets/data_driver/git/source.py": (
        "a Git data source the person connected; a data driver asset may only import the public SDK"
    ),
}

_SPAWNERS = {"run", "Popen", "call", "check_call", "check_output"}
_SHELL_VERBS = (
    "init|clone|status|rev-parse|config|add|commit|fetch|pull|push|log|diff|show|remote|checkout|ls-remote|"
    "branch|reset|worktree|--version|-C"
)
_GIT_CMD = re.compile(rf"^git ({_SHELL_VERBS})\b")


def _first_literal(node: ast.AST) -> str | None:
    if isinstance(node, (ast.List, ast.Tuple)) and node.elts:
        node = node.elts[0]
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(p.value for p in node.values if isinstance(p, ast.Constant) and isinstance(p.value, str))
    return None


def _spawns_git(call: ast.Call) -> bool:
    func = call.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
    owner = func.value.id if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) else ""
    first = _first_literal(call.args[0]) if call.args else None
    if first is None:
        return False
    if owner == "subprocess" and name in _SPAWNERS:
        return first.split()[0] == "git" if first.split() else False
    if name in ("create_subprocess_exec", "create_subprocess_shell"):
        return first.split()[0] == "git" if first.split() else False
    if owner == "os" and name == "system":
        return bool(_GIT_CMD.match(first))
    if name == "run_command":  # a command string sent to a compute node
        return bool(_GIT_CMD.match(first))
    return False


def _files_that_spawn_git() -> set[str]:
    found = set()
    for path in SDK.rglob("*.py"):
        rel = path.relative_to(SDK)
        if any(part in ("tests", "__pycache__", "static") for part in rel.parts):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        if any(isinstance(n, ast.Call) and _spawns_git(n) for n in ast.walk(tree)):
            found.add(rel.as_posix())
    return found


def test_every_direct_git_spawn_is_guarded_or_chosen_by_the_person():
    unaccounted = sorted(
        rel
        for rel in _files_that_spawn_git()
        if rel not in USER_CHOSEN and "git_usable" not in (SDK / rel).read_text(encoding="utf-8")
    )
    assert not unaccounted, (
        "These files start git themselves but never ask git_usable(), and are not listed as chosen by the "
        "person. On a Mac without the Command Line Tools they open Apple's installer dialog:\n  "
        + "\n  ".join(unaccounted)
        + "\nGuard them with flow_sdk.utils.git_usable.git_usable(), or add them to USER_CHOSEN with the reason."
    )


def test_the_allowlist_has_no_stale_entries():
    spawners = _files_that_spawn_git()
    stale = sorted(rel for rel in USER_CHOSEN if rel not in spawners)
    assert not stale, f"USER_CHOSEN lists files that no longer spawn git directly: {stale}"


def test_the_scan_finds_what_it_is_supposed_to_find():
    """If the scanner went blind this file would pass vacuously."""
    spawners = _files_that_spawn_git()
    for expected in (
        "builtin/project.py",
        "server/routes/bootstrap.py",
        "cli/cli_context.py",
        "core/flow/flow_source_control.py",
        "assets/hub_repo_sync.py",
        "builtin/faas/compute_node.py",
    ):
        assert expected in spawners, f"the scan no longer sees {expected}"

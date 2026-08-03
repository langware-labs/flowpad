"""The launcher's public contract, pinned.

``scripts/instance_ctl.sh`` is exec'd by four TS harnesses, a verification
script and a QA skill, and its ``launcher.json`` is read by roughly a dozen
independent consumers. Nothing in CI runs shellcheck and no test previously
covered any of it, so the contract lived entirely in people's heads. These
assertions are cheap; the failures they prevent are not.
"""

from __future__ import annotations

import os
import re
import subprocess

import pytest

from flow_sdk.instances import env, paths

REPO = paths.REPO_ROOT
SHIM = REPO / "scripts" / "instance_ctl.sh"

#: Directories a repo-wide grep must not descend into. ``worktrees`` matters
#: specifically: ``.claude/worktrees/*`` are checkouts of OTHER branches living
#: inside this tree, so scanning them would judge this branch by other branches'
#: content.
_SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", ".venv", "__pycache__",
    ".pytest_cache", ".mypy_cache", "_results", ".next", "worktrees",
}


def _repo_text_files():
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fname in files:
            if fname.endswith((".ts", ".tsx", ".js", ".py", ".sh", ".md", ".yml", ".yaml")):
                path = os.path.join(root, fname)
                try:
                    yield path, open(path, encoding="utf-8", errors="ignore").read()
                except OSError:
                    continue


# ── the shim ─────────────────────────────────────────────────────────────────
def test_the_shim_is_executable_with_a_bash_shebang():
    """Two callers exec it directly rather than via ``bash``.

    A lost mode bit is invisible in review and turns into ``EACCES`` at runtime.
    """
    assert SHIM.exists()
    assert SHIM.read_text().startswith("#!/usr/bin/env bash")
    assert os.access(SHIM, os.X_OK), "scripts/instance_ctl.sh lost its exec bit"


def test_both_invocation_forms_work():
    """``bash scripts/instance_ctl.sh`` and ``./scripts/instance_ctl.sh`` are
    both in use — ``_backend_lifecycle.ts`` uses the former, the api restart
    tests the latter."""
    for argv in (["bash", str(SHIM), "--help"], [str(SHIM), "--help"]):
        proc = subprocess.run(argv, cwd=REPO, capture_output=True, text=True, timeout=60)
        # `--help` exits 2 by the script's own usage convention; what matters is
        # that it ran at all rather than failing to exec.
        assert proc.returncode in (0, 2), f"{argv} → {proc.returncode}: {proc.stderr}"
        assert "instance_ctl.sh" in (proc.stdout + proc.stderr)


# ── identity contract ────────────────────────────────────────────────────────
def test_default_identity_derivation_is_the_documented_one():
    """``tests/hub_tests/*`` hard-code ``f"{BOB_INSTANCE}-pw-1234"``.

    Changing this breaks them *silently*: they fail to log in and time out
    rather than reporting a credential mismatch.
    """
    assert env.default_email("bob-x") == "bob-x@local.test"
    assert env.default_password("bob-x") == "bob-x-pw-1234"


def test_protected_instances_default_is_preserved(monkeypatch):
    monkeypatch.delenv("PROTECTED_INSTANCES", raising=False)
    assert paths.protected_instances() == frozenset({"prod", "oss", "dev-1", "dev-2"})


# ── the migration guard ──────────────────────────────────────────────────────
_STATUS_PIPE = re.compile(
    r"(instance_ctl\.sh|instance\s+ctl)\s+status\b[^\n|]*\|\s*(grep|awk|sed|cut|head|tail)"
)


def test_nothing_parses_status_text():
    """`status` output is a human/agent view, not a contract.

    The two call sites that used to grep it are why this guard exists. One
    checked ``[UP]``, which was defined as port occupancy and therefore lied;
    the other ran ``grep -oE 'backend :[0-9]+' | grep -A0 qa-cycle``, which
    strips the instance name from every line *before* searching for it, so it
    silently produced an empty port forever. Use ``--json``, ``port`` or
    ``is-up`` instead — they have exit-code semantics and cannot drift when a
    column is added.
    """
    offenders = [
        f"{path}: {m.group(0)[:90]}"
        for path, text in _repo_text_files()
        if "instance" in text
        for m in _STATUS_PIPE.finditer(text)
        if os.path.abspath(path) != os.path.abspath(__file__)
    ]
    assert not offenders, (
        "status text output is not a contract — use --json / port / is-up:\n"
        + "\n".join(offenders)
    )


def test_the_two_migrated_callers_use_the_machine_surface():
    """Pin the migration itself, so a revert is a failing test, not a silent
    reintroduction of the bug."""
    verify = (REPO / "scripts" / "verify_instance_reset.sh").read_text()
    assert "instance ctl is-up" in verify
    assert 'grep -q "^  $BYST .*UP"' not in verify

    qa = (REPO / ".claude" / "skills" / "e2e-qa" / "modes" / "qa-cycle.md").read_text()
    assert "instance ctl port qa-cycle --role backend" in qa
    # Match the executable assignment, not the prose that explains why the old
    # one was wrong — the doc deliberately quotes the broken pipeline.
    assert "QA_BE=$(grep" not in qa
    assert "<(scripts/instance_ctl.sh status)" not in qa


# ── CLI behavior the exec callers depend on ──────────────────────────────────
def _ctl(*args, stdin=subprocess.DEVNULL):
    return subprocess.run(
        ["uv", "run", "flow", "instance", "ctl", *args],
        cwd=REPO, capture_output=True, text=True, timeout=180, stdin=stdin,
    )


@pytest.mark.timeout(200)
def test_is_up_on_a_never_allocated_name_exits_one_with_no_output():
    proc = _ctl("is-up", "never-allocated-xyz")
    assert proc.returncode == 1
    assert proc.stdout == ""


@pytest.mark.timeout(200)
def test_port_on_a_never_allocated_name_prints_nothing_to_stdout():
    """`PORT=$(… port x)` must yield an empty variable, never a diagnostic that
    a caller then treats as a port number."""
    proc = _ctl("port", "never-allocated-xyz")
    assert proc.returncode == 3
    assert proc.stdout.strip() == ""
    assert "not allocated" in proc.stderr


@pytest.mark.timeout(200)
def test_an_illegal_name_is_refused_with_a_typed_code_not_a_traceback():
    proc = _ctl("status", "../../etc")
    assert proc.returncode == 2
    assert "Traceback" not in proc.stderr
    assert "invalid instance name" in proc.stderr


@pytest.mark.timeout(200)
def test_status_never_reads_stdin():
    """Four callers run this with ``stdio: 'ignore'``; a prompt would be an
    infinite hang rather than an error."""
    proc = _ctl("status", stdin=subprocess.DEVNULL)
    assert proc.returncode == 0


@pytest.mark.timeout(200)
def test_piped_output_carries_no_ansi_escapes():
    proc = _ctl("status")
    assert "\033" not in proc.stdout


# ── test-safety guard ────────────────────────────────────────────────────────
def test_process_killing_tests_are_scoped_to_unique_names():
    """No test may kill by a name that could match a REAL instance.

    ``FLOW_HOME`` redirects on-disk state, but the process table is
    machine-global. A test that spawns a child called ``dev-2`` and then kills
    "dev-2" terminates the developer's actual dev-2 frontend, and an unscoped
    ``manager.reap()`` run against a throwaway instance root treats every real
    instance on the machine as unaccounted-for and kills it. Both happened while
    this suite was being written — it took out five live dev servers.

    The two rules that prevent it: names come from the ``iname`` fixture, and
    every ``reap``/``gc`` call passes ``only=``.
    """
    src = (REPO / "tests" / "cli" / "test_instance_kill_isolation.py").read_text()

    for call in re.finditer(r"manager\.(reap|gc)\((.*?)\)", src, re.S):
        assert "only=" in call.group(2), (
            f"unscoped manager.{call.group(1)}() in test_instance_kill_isolation.py "
            "— it would reap the whole machine"
        )

    # Every spawned/killed name must be an iname(...) call, never a literal.
    for call in re.finditer(r"(spawn_owned|kill_owned|kill_port_if_owned)\(\s*\"([^\"]+)\"", src):
        raise AssertionError(
            f"literal instance name {call.group(2)!r} passed to {call.group(1)} "
            "— use the `iname` fixture so it cannot match a real instance"
        )

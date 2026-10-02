"""``flow status --check`` — the exit code a setup step's completion check reads.

A wizard asks "is Claude Code installed" through this, right after running its installer. So the
check must re-discover the harness it names (the install is the one fact that just changed), must
not re-probe every other vendor's login to answer it, and must accept the user's ``default``.
"""
from __future__ import annotations

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import status_cmd

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

CLAUDE, CODEX = "harness.claude.cli", "harness.codex.cli"


def _record(*, claude: str, codex: str = "installed", default: str = CLAUDE) -> dict:
    harness = lambda kind, worker, install: {"kind": kind, "worker_type": worker, "install": install}  # noqa: E731
    return {
        "harnesses": [harness(CLAUDE, "claude", claude), harness(CODEX, "codex", codex)],
        "keys": [],
        "hub": {"login": "signed_out"},
        "default_harness": default,
    }


@pytest.fixture
def fetched(monkeypatch):
    """Every `_fetch` call, answered from ``answer["record"]``."""
    calls: list[tuple[bool, list[str] | None]] = []
    answer = {"record": _record(claude="installed")}

    def fake_fetch(refresh: bool, kinds: list[str] | None = None) -> dict:
        calls.append((refresh, kinds))
        return answer["record"]

    monkeypatch.setattr(status_cmd, "_fetch", fake_fetch)
    return calls, answer


def _check(*args: str) -> int:
    return CliRunner().invoke(status_cmd.status_app, list(args)).exit_code


def test_an_installed_harness_passes_and_a_missing_one_fails(fetched):
    _calls, answer = fetched
    answer["record"] = _record(claude="not_installed")

    assert _check("--check", "install:codex") == 0
    assert _check("--check", "install:claude") == status_cmd.EXIT_CHECK_FAILED
    assert _check("--check", f"install:{CODEX}") == 0


def test_the_refresh_rediscovers_only_the_harness_it_asks_about(fetched):
    calls, _answer = fetched

    assert _check("--refresh", "--check", "install:claude") == 0

    assert calls == [(True, [CLAUDE])]


def test_default_names_the_users_default_harness(fetched):
    calls, answer = fetched
    answer["record"] = _record(claude="not_installed", codex="installed", default=CODEX)

    assert _check("--refresh", "--check", "install:default") == 0
    # One read to learn which harness is the default, then a refresh of that one only.
    assert calls == [(False, None), (True, [CODEX])]


def test_an_unknown_check_is_an_argument_error(fetched):
    assert _check("--check", "login:claude") == status_cmd.EXIT_INVALID_ARG
    assert _check("--check", "install:nope") == status_cmd.EXIT_INVALID_ARG

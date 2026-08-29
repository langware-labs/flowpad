"""`flow navigate file <path>` — the path is resolved HERE, before it is sent.

The same defect `flow show file` had (FLOWPAD-1992), on the sibling command that
shares the resolver. A relative path means "relative to the agent's cwd", and
that cwd never crosses the wire, so the server has nothing to resolve it against
but its OWN launch directory:

    $ cd "~/Flowpad workspace/FLOWPAD-1992"
    $ flow navigate file hello.html
    -> the tab navigates to C:/Users/.../.local/bin/hello.html -> 404

`hello.html` existed in the caller's project; the navigated path did not exist at
all, and the route still answered `ok: true`.

These assert on the BODY the CLI puts on the wire, which is where the fix lives.
The real Typer app is invoked (`flow_cli.app`), so the argument really passes
through `navigate_file`; only the transport underneath it is captured.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import navigate_cmd
from flow_sdk.cli.flow_cli import app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()


@pytest.fixture
def sent_body(monkeypatch):
    """Capture the JSON body `flow navigate` would POST, without a server.

    Only the transport is replaced — port discovery and the HTTP call. Argument
    parsing and the path handling under test run for real.
    """
    captured: dict = {}

    class _Resp:
        status_code = 200

        @staticmethod
        def json() -> dict:
            return {"ok": True, "mode": "vfs", "path": captured.get("path")}

    def _fake_post(url, json=None, timeout=None, **kwargs):
        captured.update(json or {})
        return _Resp()

    monkeypatch.setattr(navigate_cmd, "_discover_port", lambda: 9999)
    monkeypatch.setattr(navigate_cmd, "_local_post", _fake_post)
    return captured


def _navigate(path: str):
    return runner.invoke(app, ["navigate", "file", path])


def test_a_relative_path_is_sent_absolute_and_rooted_at_the_callers_cwd(sent_body, tmp_path, monkeypatch) -> None:
    """The defect: `hello.html` reached the server verbatim, to be misresolved."""
    (tmp_path / "hello.html").write_text("<h1>Hello World</h1>", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    result = _navigate("hello.html")

    assert result.exit_code == 0, result.output
    sent = sent_body["path"]
    assert os.path.isabs(sent), f"a relative path went out unresolved: {sent!r}"
    assert Path(sent) == tmp_path / "hello.html", f"the path was not anchored to the caller's cwd: {sent!r}"


@pytest.mark.parametrize("spelling", ["hello.html", "./hello.html", "sub/hello.html"])
def test_every_relative_spelling_goes_out_absolute(sent_body, tmp_path, monkeypatch, spelling) -> None:
    """`x`, `./x` and `sub/x` are all relative, however they are written."""
    monkeypatch.chdir(tmp_path)

    assert _navigate(spelling).exit_code == 0
    assert os.path.isabs(sent_body["path"]), sent_body["path"]


def test_a_tilde_path_is_expanded_before_it_is_sent(sent_body, tmp_path, monkeypatch) -> None:
    """`~` is the CLI's documented form; the server must not receive it raw."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))  # expanduser's Windows source

    assert _navigate("~/hello.html").exit_code == 0
    sent = sent_body["path"]
    assert "~" not in sent, f"tilde reached the wire: {sent!r}"
    assert os.path.isabs(sent)


def test_an_absolute_path_is_passed_through_unchanged(sent_body, tmp_path, monkeypatch) -> None:
    """Control — the address that already worked must not be rewritten.

    Chdir'd elsewhere on purpose: an absolute path must not pick up the cwd.
    """
    page = tmp_path / "hello.html"
    page.write_text("<h1>Hello World</h1>", encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    assert _navigate(str(page)).exit_code == 0
    assert Path(sent_body["path"]) == page


def test_an_empty_path_still_exits_2(sent_body) -> None:
    """Control — the pre-existing argument contract is unchanged."""
    assert _navigate("   ").exit_code == navigate_cmd.EXIT_INVALID_ARG
    assert "path" not in sent_body, "a rejected argument must not reach the wire"

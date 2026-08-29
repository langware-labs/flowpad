"""`flow artifact file <path>` — the path is resolved HERE, before it is sent.

The third caller of the shared resolver, with the same defect `flow show file`
had (FLOWPAD-1992). A relative path means "relative to the agent's cwd", and
that cwd never crosses the wire, so the server resolves it against its OWN
launch directory instead:

    $ cd "~/Flowpad workspace/FLOWPAD-1992"
    $ flow artifact file report.html
    -> an Artifact row pointing at C:/Users/.../.local/bin/report.html

The registration succeeds, so the agent believes the deliverable was recorded;
what got recorded is a file that does not exist.

These assert on the BODY the CLI puts on the wire, which is where the fix lives.
The real Typer app is invoked (`flow_cli.app`), so the argument really passes
through `artifact_file`; only the transport underneath it is captured.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import artifact_cmd
from flow_sdk.cli.flow_cli import app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()

_PROC = "--process=3f2a1b4c-0000-4000-8000-0000000000aa"


@pytest.fixture
def sent_body(monkeypatch):
    """Capture the JSON body `flow artifact` would POST, without a server.

    Only the transport is replaced — port discovery and the HTTP call. Argument
    parsing and the path handling under test run for real.
    """
    captured: dict = {}

    def _fake_post(url, body, timeout=None, on_error=None):
        captured.update(body)
        return {"artifact": {"id": "artifact-1"}, "shown": True}

    monkeypatch.setattr(artifact_cmd, "_discover_port", lambda: 9999)
    monkeypatch.setattr(artifact_cmd, "_post_graph_json", _fake_post)
    return captured


def _artifact(path: str):
    return runner.invoke(app, ["artifact", "file", path, _PROC])


def test_a_relative_path_is_sent_absolute_and_rooted_at_the_callers_cwd(sent_body, tmp_path, monkeypatch) -> None:
    """The defect: `report.html` reached the server verbatim, to be misresolved."""
    (tmp_path / "report.html").write_text("<h1>Report</h1>", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    result = _artifact("report.html")

    assert result.exit_code == 0, result.output
    sent = sent_body["path"]
    assert os.path.isabs(sent), f"a relative path went out unresolved: {sent!r}"
    assert Path(sent) == tmp_path / "report.html", f"the path was not anchored to the caller's cwd: {sent!r}"


@pytest.mark.parametrize("spelling", ["report.html", "./report.html", "sub/report.html"])
def test_every_relative_spelling_goes_out_absolute(sent_body, tmp_path, monkeypatch, spelling) -> None:
    """`x`, `./x` and `sub/x` are all relative, however they are written."""
    monkeypatch.chdir(tmp_path)

    assert _artifact(spelling).exit_code == 0
    assert os.path.isabs(sent_body["path"]), sent_body["path"]


def test_a_tilde_path_is_expanded_before_it_is_sent(sent_body, tmp_path, monkeypatch) -> None:
    """`~` is the CLI's documented form; the server must not receive it raw."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))  # expanduser's Windows source

    assert _artifact("~/report.html").exit_code == 0
    sent = sent_body["path"]
    assert "~" not in sent, f"tilde reached the wire: {sent!r}"
    assert os.path.isabs(sent)


def test_an_absolute_path_is_passed_through_unchanged(sent_body, tmp_path, monkeypatch) -> None:
    """Control — the address that already worked must not be rewritten.

    Chdir'd elsewhere on purpose: an absolute path must not pick up the cwd.
    """
    page = tmp_path / "report.html"
    page.write_text("<h1>Report</h1>", encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    assert _artifact(str(page)).exit_code == 0
    assert Path(sent_body["path"]) == page


def test_the_other_fields_still_ride_along(sent_body, tmp_path, monkeypatch) -> None:
    """Control — absolutizing the path must not disturb the rest of the body."""
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["artifact", "file", "report.html", "--name", "Report", "--no-show", _PROC])

    assert result.exit_code == 0, result.output
    assert sent_body["name"] == "Report"
    assert sent_body["show"] is False


def test_an_empty_path_still_exits_2(sent_body) -> None:
    """Control — the pre-existing argument contract is unchanged."""
    assert _artifact("   ").exit_code == artifact_cmd.EXIT_INVALID_ARG
    assert "path" not in sent_body, "a rejected argument must not reach the wire"

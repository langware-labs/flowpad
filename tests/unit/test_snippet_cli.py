"""`flow show snippet` and `flow snippet run`, through the real Typer app.

Only the HTTP transport of `flow show` is captured; file handling, marker
validation and running are real. python3 only — the other toolchains are the
same `run_snippet` (tests/unit/test_snippet.py).
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import show_cmd
from flow_sdk.cli.flow_cli import app
from flow_sdk.core import snippet as snippet_mod

runner = CliRunner()
_PROC = "--process=3f2a1b4c-0000-4000-8000-0000000000aa"
CODE = "# %% flowpad:hidden\nimport json\n# %% flowpad:snippet\nprint(json.dumps([1]))\n"


@pytest.fixture
def sent_body(monkeypatch):
    captured: dict = {}

    def _fake_post(url, body, timeout=None, on_error=None):
        captured.update(body)
        return {"kind": "vfs", "path": body.get("path")}

    monkeypatch.setattr(show_cmd, "_discover_port", lambda: 9999)
    monkeypatch.setattr(show_cmd, "_post_graph_json", _fake_post)
    return captured


@pytest.fixture(autouse=True)
def _toolchain_path(monkeypatch):
    monkeypatch.setattr(snippet_mod, "_terminal_path", lambda: os.environ["PATH"])


def test_stdin_code_lands_in_the_os_temp_dir_and_is_shown(sent_body, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["show", "snippet", "--name", "t-cli-stdin", _PROC], input=CODE)
    assert result.exit_code == 0, result.output
    sent = Path(sent_body["path"])
    try:
        assert sent.parent.resolve() == (Path(tempfile.gettempdir()) / "flowpad-snippets").resolve()
        assert sent.name == "t-cli-stdin.py"
        assert sent.read_text() == CODE
        assert not any(tmp_path.iterdir()), "nothing may be written into the caller's folder"
        assert json.loads(result.output)["path"] == str(sent)
    finally:
        sent.unlink(missing_ok=True)


def test_lang_sets_the_extension(sent_body):
    result = runner.invoke(app, ["show", "snippet", "--lang", "rs", "--name", "t-cli-rs", _PROC], input="// %% flowpad:snippet\nfn main() {}\n")
    assert result.exit_code == 0, result.output
    sent = Path(sent_body["path"])
    try:
        assert sent.suffix == ".rs"
    finally:
        sent.unlink(missing_ok=True)


def test_an_existing_file_is_shown_where_it_is(sent_body, tmp_path, monkeypatch):
    (tmp_path / "mine.py").write_text(CODE)
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["show", "snippet", "mine.py", _PROC])
    assert result.exit_code == 0, result.output
    assert Path(sent_body["path"]) == tmp_path / "mine.py"


@pytest.mark.parametrize(
    ("args", "stdin", "code", "error"),
    [
        (["show", "snippet"], "", 2, "EMPTY_SNIPPET"),
        (["show", "snippet"], "print(1)\n", 2, "NOT_A_SNIPPET"),
        (["show", "snippet", "/definitely/not/here.py"], None, 4, "NOT_FOUND"),
    ],
)
def test_refusals_show_nothing(sent_body, args, stdin, code, error):
    result = runner.invoke(app, [*args, _PROC], input=stdin)
    assert result.exit_code == code, result.output
    assert error in result.output
    assert sent_body == {}, "a refused snippet must not be shown"


def _run(tmp_path: Path, body: str, *extra: str):
    path = tmp_path / "r.py"
    path.write_text(f"# %% flowpad:snippet\n{body}\n")
    result = runner.invoke(app, ["snippet", "run", str(path), *extra])
    return result, json.loads(result.stdout.strip().splitlines()[-1])


def test_run_exit_codes_mirror_the_snippet(tmp_path):
    result, data = _run(tmp_path, "print('hi')")
    assert (result.exit_code, data["stdout"]) == (0, "hi\n")
    result, data = _run(tmp_path, "raise SystemExit(7)")
    assert result.exit_code == 7
    result, data = _run(tmp_path, "1/0")
    assert result.exit_code == 1 and "ZeroDivisionError" in data["stderr"]
    result, data = _run(tmp_path, "import time\nprint('a', flush=True)\ntime.sleep(60)", "--timeout", "0.3")
    assert result.exit_code == 124 and data["timed_out"] and data["stdout"] == "a\n"


def test_run_of_something_unrunnable_exits_2(tmp_path):
    result = runner.invoke(app, ["snippet", "run", str(tmp_path / "missing.py")])
    assert result.exit_code == 2
    assert "not found" in json.loads(result.stdout)["stderr"]

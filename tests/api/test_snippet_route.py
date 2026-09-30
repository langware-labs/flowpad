"""POST /api/v1/snippet/{read,save,check,terminal} — the snippet view's backend.

The rules live in ``flow_sdk.core.snippet`` (tests/unit/test_snippet.py); this
proves the wire: shapes, error codes, and that a file runs in ITS terminal — the
one ``/snippet/terminal`` names, typed into through the shell's ``run-command``.
"""

import asyncio
import os

import pytest

from flow_sdk.core import snippet as snippet_mod

pytestmark = pytest.mark.asyncio

SNIPPET = "import sys\n# %% flowpad:hidden\nimport json\n# %% flowpad:init\nd = {'a': 1}\n# %% flowpad:snippet\nprint(json.dumps(d))\n"


@pytest.fixture(autouse=True)
def _toolchain_path(monkeypatch):
    """The route looks toolchains up on a login shell's PATH; python3 is on ours."""
    monkeypatch.setattr(snippet_mod, "_terminal_path", lambda: os.environ["PATH"])


async def _post(client, verb: str, body: dict) -> dict:
    resp = await client.post(f"/api/v1/snippet/{verb}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _error_code(payload: dict) -> str:
    assert payload["status"] != "SUCCESS", payload
    return (payload.get("data") or {}).get("error_code")


async def test_read_returns_each_region_as_the_viewer_edits_it(client, tmp_path):
    path = tmp_path / "s.py"
    path.write_text(SNIPPET)
    data = (await _post(client, "read", {"path": str(path)}))["data"]
    assert data["path"] == str(path.resolve())
    assert data["text"] == SNIPPET
    assert data["regions"] == [
        {"index": 0, "kind": "hidden", "shown": "import sys", "line": 1},  # before the first marker
        {"index": 1, "kind": "hidden", "shown": "import json", "line": 3},
        {"index": 2, "kind": "init", "shown": "d = {'a': 1}", "line": 5},
        {"index": 3, "kind": "snippet", "shown": "print(json.dumps(d))", "line": 7},
    ]


async def test_save_against_text_that_changed_on_disk_is_refused(client, tmp_path):
    path = tmp_path / "s.py"
    path.write_text(SNIPPET.replace("print(json.dumps(d))", "print('agent')"))
    body = {"path": str(path), "index": 3, "kind": "snippet", "shown": "print(1)", "base": "print(json.dumps(d))"}
    assert _error_code(await _post(client, "save", body)) == "STALE"
    assert "print('agent')" in path.read_text()


async def _run_in_its_terminal(client, path) -> tuple[int, str]:
    """What the viewer does on Run: the file's terminal, then its command typed there; the exit
    code and what it printed, read from the terminal's own stream."""
    from flow_sdk.builtin.shell import Shell, _strip_pty_keep_lines

    term = (await _post(client, "terminal", {"path": str(path)}))["data"]
    resp = await client.post(f"/api/v1/graph/shell/{term['shell_id']}/run-command", json={"command": term["command"]})
    marker = resp.json()["data"]["marker"]
    shell = await Shell.get_by_id(term["shell_id"])
    for _ in range(200):
        raw = await shell.read()
        done = Shell.sentinel_exit(raw, marker)
        if done:
            return done[0], _strip_pty_keep_lines(Shell.sentinel_output(raw, marker))
        await asyncio.sleep(0.05)
    raise TimeoutError(f"the run never ended: {raw[-300:]!r}")


async def test_a_file_has_one_terminal_and_another_file_its_own(client, tmp_path):
    first, second = tmp_path / "a.py", tmp_path / "b.py"
    first.write_text(SNIPPET)
    second.write_text(SNIPPET)
    none_yet = (await _post(client, "terminal", {"path": str(first), "create": False}))["data"]
    assert none_yet["shell_id"] is None, "a file never run has no terminal, and finding one makes none"
    one = (await _post(client, "terminal", {"path": str(first)}))["data"]
    assert (await _post(client, "terminal", {"path": str(first), "create": False}))["data"]["shell_id"] == one["shell_id"]
    again = (await _post(client, "terminal", {"path": str(first)}))["data"]
    other = (await _post(client, "terminal", {"path": str(second)}))["data"]
    assert one["shell_id"] == again["shell_id"] != other["shell_id"]
    assert one["command"].endswith(f"-m flow_sdk.snippet_launch {first.resolve()}")


async def test_the_file_runs_in_its_terminal_and_its_exit_code_comes_back(client, tmp_path):
    ok = tmp_path / "ok.py"
    ok.write_text(SNIPPET)
    code, printed = await _run_in_its_terminal(client, ok)
    assert code == 0 and '{"a": 1}' in printed

    boom = tmp_path / "boom.py"
    boom.write_text("# %% flowpad:hidden\nimport os\n\n# %% flowpad:snippet\nx = 1\nraise KeyError('k')\n")
    region = (await _post(client, "read", {"path": str(boom)}))["data"]["regions"][1]
    code, printed = await _run_in_its_terminal(client, boom)
    assert code == 1 and "KeyError: 'k'" in printed
    failing_line = region["line"] + region["shown"].split("\n").index("raise KeyError('k')")
    assert f"line {failing_line}" in printed, "a traceback names the file's own line"


async def test_a_terminal_for_a_missing_file_or_an_unknown_language_is_refused(client, tmp_path):
    assert _error_code(await _post(client, "terminal", {"path": str(tmp_path / "gone.py")})) == "NOT_FOUND"
    cobol = tmp_path / "x.cobol"
    cobol.write_text("# %% flowpad:snippet\n")
    assert _error_code(await _post(client, "terminal", {"path": str(cobol)})) == "NOT_APPLICABLE"


async def test_a_rejected_body_answers_in_the_standard_envelope(client, tmp_path):
    """A 422 is a FAIL envelope with a sentence, like every other failure.

    FastAPI handles `RequestValidationError` itself, so it never reaches the catch-all
    middleware, and a route bound straight to FastAPI used to answer with a raw
    `{"detail": [ {...} ]}` — a shape no client of ours reads. `apiClient` unwraps
    `{status,data}`; the UI's error reader was handed that LIST where it expected a
    sentence, put an object into React, and the whole page was replaced by the error
    screen. A mistyped field must not be able to do that.
    """
    resp = await client.post("/api/v1/snippet/terminal", json={"path": str(tmp_path / "x.py"), "bogus": 1})

    assert resp.status_code == 422
    body = resp.json()
    assert body["status"] == "FAIL" and body["data"] is None
    assert body["message"] == "body.bogus: Extra inputs are not permitted"
    assert "detail" not in body, "the raw pydantic issue list must not reach a client"


async def test_check_answers_problems_in_file_lines_and_a_clean_file_none(client, tmp_path):
    ok = tmp_path / "ok.py"
    ok.write_text(SNIPPET)
    assert (await _post(client, "check", {"path": str(ok)}))["data"] == {"path": str(ok.resolve()), "diagnostics": []}

    bad = tmp_path / "bad.py"
    bad.write_text("# %% flowpad:hidden\nimport json\n# %% flowpad:snippet\nprint(json.dumps(NOTES))\n")
    (d,) = (await _post(client, "check", {"path": str(bad)}))["data"]["diagnostics"]
    assert (d["line"], d["col"], d["end_col"], d["kind"]) == (4, 18, 23, "name")

    assert _error_code(await _post(client, "check", {"path": str(tmp_path / "nope.py")})) == "NOT_FOUND"

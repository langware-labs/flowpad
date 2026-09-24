"""POST /api/v1/snippet/{read,save,run} — the snippet view's backend.

The rules live in ``flow_sdk.core.snippet`` (tests/unit/test_snippet.py); this
proves the wire: shapes, error codes, and that a crash or hang is a result to
show, never an HTTP failure. python3 only — node/rust are proven in the unit
tier, and the route runs them through the same function.
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


async def test_region_line_is_the_line_a_traceback_names(client, tmp_path):
    path = tmp_path / "tb.py"
    path.write_text("# %% flowpad:hidden\nimport os\n\n# %% flowpad:snippet\nx = 1\nraise RuntimeError('here')\n")
    region = (await _post(client, "read", {"path": str(path)}))["data"]["regions"][1]
    run = (await _post(client, "run", {"path": str(path)}))["data"]
    failing_line = region["line"] + region["shown"].split("\n").index("raise RuntimeError('here')")
    assert f"line {failing_line}" in run["stderr"]


async def test_read_refusals_carry_their_error_code(client, tmp_path):
    assert _error_code(await _post(client, "read", {"path": str(tmp_path / "nope.py")})) == "NOT_FOUND"
    plain = tmp_path / "plain.py"
    plain.write_text("print(1)\n")
    assert _error_code(await _post(client, "read", {"path": str(plain)})) == "NOT_A_SNIPPET"


async def test_unknown_body_keys_are_rejected(client, tmp_path):
    resp = await client.post("/api/v1/snippet/read", json={"path": str(tmp_path), "pth": "typo"})
    assert resp.status_code == 422


async def test_save_writes_only_that_region_and_answers_the_reread_file(client, tmp_path):
    path = tmp_path / "s.py"
    path.write_text(SNIPPET)
    data = (await _post(client, "save", {"path": str(path), "index": 3, "kind": "snippet", "shown": "print(d['a'])"}))["data"]
    assert data["regions"][3]["shown"] == "print(d['a'])"
    assert path.read_text() == SNIPPET.replace("print(json.dumps(d))", "print(d['a'])")
    assert data["text"] == path.read_text()


async def test_save_by_a_stale_position_is_refused_and_writes_nothing(client, tmp_path):
    path = tmp_path / "s.py"
    path.write_text(SNIPPET)
    payload = await _post(client, "save", {"path": str(path), "index": 0, "kind": "snippet", "shown": "x"})
    assert _error_code(payload) == "STALE"
    assert path.read_text() == SNIPPET


async def test_save_against_text_that_changed_on_disk_is_refused(client, tmp_path):
    path = tmp_path / "s.py"
    path.write_text(SNIPPET.replace("print(json.dumps(d))", "print('agent')"))
    body = {"path": str(path), "index": 3, "kind": "snippet", "shown": "print(1)", "base": "print(json.dumps(d))"}
    assert _error_code(await _post(client, "save", body)) == "STALE"
    assert "print('agent')" in path.read_text()


async def test_run_ok_exception_syntax_and_hang_are_all_results(client, tmp_path):
    ok = tmp_path / "ok.py"
    ok.write_text(SNIPPET)
    r = (await _post(client, "run", {"path": str(ok)}))["data"]
    assert (r["returncode"], r["stdout"], r["timed_out"]) == (0, '{"a": 1}\n', False)

    boom = tmp_path / "boom.py"
    boom.write_text("# %% flowpad:snippet\nraise KeyError('k')\n")
    r = (await _post(client, "run", {"path": str(boom)}))["data"]
    assert r["returncode"] == 1 and "KeyError: 'k'" in r["stderr"]

    bad = tmp_path / "bad.py"
    bad.write_text("# %% flowpad:snippet\nif True print(1)\n")
    r = (await _post(client, "run", {"path": str(bad)}))["data"]
    assert r["returncode"] == 1 and "SyntaxError" in r["stderr"]

    hang = tmp_path / "hang.py"
    hang.write_text("# %% flowpad:snippet\nprint('before', flush=True)\nwhile True:\n    pass\n")
    r = (await _post(client, "run", {"path": str(hang), "timeout_seconds": 0.3}))["data"]
    assert r["timed_out"] and r["stdout"] == "before\n"


async def test_stop_route_ends_a_hanging_run(client, tmp_path):
    hang = tmp_path / "hang.py"
    hang.write_text("# %% flowpad:snippet\nprint('up', flush=True)\nwhile True:\n    pass\n")
    run = asyncio.create_task(_post(client, "run", {"path": str(hang), "timeout_seconds": 30, "run_id": "api-1"}))
    await asyncio.sleep(0.4)
    assert (await _post(client, "stop", {"run_id": "api-1"}))["data"] == {"stopped": True}
    r = (await asyncio.wait_for(run, 5))["data"]
    assert not r["timed_out"] and r["detail"] == "The run was stopped." and r["stdout"] == "up\n"
    assert (await _post(client, "stop", {"run_id": "api-1"}))["data"] == {"stopped": False}


async def test_run_timeout_is_bounded(client, tmp_path):
    for bad in (0, -1, 601):
        resp = await client.post("/api/v1/snippet/run", json={"path": str(tmp_path / "x.py"), "timeout_seconds": bad})
        assert resp.status_code == 422, bad


async def test_run_of_a_missing_file_is_a_result_not_a_crash(client, tmp_path):
    r = (await _post(client, "run", {"path": str(tmp_path / "gone.py")}))["data"]
    assert r["returncode"] is None and "not found" in r["stderr"]


async def test_ten_concurrent_runs_through_the_route(client, tmp_path):
    paths = []
    for i in range(10):
        p = tmp_path / f"c{i}.py"
        p.write_text(f"# %% flowpad:snippet\nprint({i})\n")
        paths.append(p)
    results = await asyncio.gather(*(_post(client, "run", {"path": str(p)}) for p in paths))
    assert [r["data"]["stdout"] for r in results] == [f"{i}\n" for i in range(10)]


async def test_a_rejected_body_answers_in_the_standard_envelope(client, tmp_path):
    """A 422 is a FAIL envelope with a sentence, like every other failure.

    FastAPI handles `RequestValidationError` itself, so it never reaches the catch-all
    middleware, and a route bound straight to FastAPI used to answer with a raw
    `{"detail": [ {...} ]}` — a shape no client of ours reads. `apiClient` unwraps
    `{status,data}`; the UI's error reader was handed that LIST where it expected a
    sentence, put an object into React, and the whole page was replaced by the error
    screen. A mistyped field must not be able to do that.
    """
    resp = await client.post("/api/v1/snippet/run", json={"path": str(tmp_path / "x.py"), "bogus": 1})

    assert resp.status_code == 422
    body = resp.json()
    assert body["status"] == "FAIL" and body["data"] is None
    assert body["message"] == "body.bogus: Extra inputs are not permitted"
    assert "detail" not in body, "the raw pydantic issue list must not reach a client"

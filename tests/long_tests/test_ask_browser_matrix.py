"""The ask op, answered by a person in a real browser.

**Wall-clock and browser bound, so it lives here** — a tier CI excludes. It is
the only test that proves a person can actually answer; everything else proves
the machinery around the question.

Self-contained on purpose. The pending question lives in the process running
the op, so this starts the real app in-process (uvicorn on a real port) and the
op runs beside it — the page's POST lands in the same registry the op is
waiting on. A Vite dev server renders the UI FROM SOURCE, because the built
bundle under `server/static` is whatever was last compiled and would not
contain a view added today.

No mocks anywhere: a real HTTP server, a real browser, a real op, a real
person's keystrokes (typed by Playwright).

    uv run pytest tests/long_tests/test_ask_browser_matrix.py
"""
from __future__ import annotations

import asyncio
import functools
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.timeout(300)  # do not increase timeout without approval

REPO = Path(__file__).resolve().parents[2]
UI = REPO / "ui"
#: Lives under ui/ because node resolves imports from the SCRIPT's directory,
#: not the cwd — a driver outside ui/ cannot see ui/node_modules/playwright.
DRIVER = UI / "tests" / "ask_browser" / "drive_ask.mjs"
def _real_home() -> Path:
    """The person's home, not the test harness's.

    The suite redirects ``HOME`` to a temp directory for isolation, which also
    hides nvm — so looking for node under ``Path.home()`` finds nothing and the
    browser tests skip for a reason that has nothing to do with node.
    """
    try:
        import pwd  # noqa: PLC0415 — POSIX only, and this test is POSIX only

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except Exception:  # noqa: BLE001
        return Path.home()


#: Where a node might be. pytest does not inherit a login shell, so an nvm node
#: is invisible unless it is looked for — and hardcoding one version is how this
#: skips silently on the next machine.
def _node_dirs() -> "list[Path]":
    found = sorted((_real_home() / ".nvm" / "versions" / "node").glob("*/bin"), reverse=True)
    return [*found, Path("/opt/homebrew/bin"), Path("/usr/local/bin")]

#: How long a person gets in THIS test. Shorter than the product default so a
#: driver that never finds the window fails the test instead of holding it.
#: Nothing here lengthens ASK_TIMEOUT_SECONDS.
ASK_BUDGET = 45.0


def _free_port() -> int:
    """A free port, not the repo's ``allocate_ports`` fixture.

    That one is built on pytest-asyncio's function-scoped
    ``unused_tcp_port_factory``, and the backend and Vite here are MODULE
    scoped — starting a Vite per test would cost five boots instead of one.
    A module-scoped fixture cannot depend on a function-scoped one.
    """
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _node_env() -> dict:
    """Env for node and vite, with the REAL home put back.

    The suite redirects ``HOME`` for isolation, and Playwright keeps its
    browsers under ``$HOME/Library/Caches/ms-playwright`` — so a redirected
    home makes an installed chromium invisible and the driver dies saying it
    was "just installed or updated". Node is found the same way.
    """
    home = str(_real_home())
    extra = [str(d) for d in _node_dirs() if (d / "node").exists()]
    return {
        **os.environ,
        "HOME": home,
        "PATH": ":".join([*extra, os.environ.get("PATH", "")]),
    }


def _node_exe() -> "str | None":
    """The node binary, or None. Looked up once, used everywhere."""
    for directory in _node_dirs():
        candidate = directory / "node"
        if candidate.exists():
            return str(candidate)
    return shutil.which("node")


@pytest.fixture(scope="module")
def backend_port() -> int:
    """The real app, in THIS process, on a real port.

    In-process is not a convenience: the question the op is waiting on lives in
    this process's registry, and a subprocess backend would answer into its own.
    """
    import uvicorn

    from flow_sdk.server.app import app

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        try:
            if httpx.get(f"http://127.0.0.1:{port}/api/v1/ask", timeout=1.0).status_code < 500:
                break
        except Exception:  # noqa: BLE001 — not up yet
            time.sleep(0.1)
    else:
        pytest.skip("the in-process backend never became reachable")
    yield port
    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture(scope="module")
def frontend(backend_port: int) -> str:
    """Vite, from source, pointed at the in-process backend."""
    node = _node_exe()
    if node is None:
        pytest.skip("no node found (nvm, homebrew or PATH) — the browser half needs it")
    if not (UI / "node_modules").is_dir():
        pytest.skip("ui/node_modules missing — run `npm install` in ui/")
    if not DRIVER.is_file():
        pytest.skip(f"browser driver missing at {DRIVER}")

    port = _free_port()
    env = {
        **_node_env(),
        "VITE_API_URL": f"http://127.0.0.1:{backend_port}",
        "FLOWPAD_SKIP_DOTENV": "true",
    }
    vite = subprocess.Popen(
        [str(Path(node).parent / "npm"), "run", "dev", "--", "--port", str(port), "--strictPort"],
        cwd=UI, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    base = f"http://localhost:{port}"
    for _ in range(600):
        if vite.poll() is not None:
            pytest.skip(f"vite exited: {(vite.stdout.read() or '')[-400:]}")
        try:
            if httpx.get(base, timeout=1.0).status_code < 500:
                break
        except Exception:  # noqa: BLE001 — not up yet
            time.sleep(0.1)
    else:
        vite.kill()
        pytest.skip("vite never became reachable")
    yield base
    vite.terminate()
    try:
        vite.wait(timeout=10)
    except subprocess.TimeoutExpired:
        vite.kill()


@pytest.fixture(autouse=True)
def _record_browser_opens(monkeypatch, tmp_path_factory):
    """No tab is listening when these ops ask, so the window path runs for real.

    Point it at a recorder instead of a browser: the test already drives its
    own chromium, and a second window opening on the developer's desktop on
    every run is not a test, it is a nuisance. ``BROWSER`` is honoured by
    ``webbrowser``, so this exercises the real code rather than skipping it.
    """
    log = tmp_path_factory.mktemp("opens") / "urls.txt"
    recorder = log.parent / "record.sh"
    recorder.write_text(f'#!/bin/sh\necho "$1" >> {log}\n', encoding="utf-8")
    recorder.chmod(0o755)
    monkeypatch.setenv("BROWSER", f"{recorder} %s")
    return log


def _spec():
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

    # No completion check: a call, not a goal — what the person types IS the
    # answer, with nothing on this machine to re-prove it against.
    return ComputeOpSpec.model_validate({
        "name": "e2e-ask-token",
        "label": "E2E API token",
        "attempts": [{"kind": "ask", "prompt": "E2E: type a token"}],
        "output": {"token": "string"},
    })


async def _question_id(timeout: float = 30.0) -> str:
    from flow_sdk.core.compute.ask import open_questions

    for _ in range(int(timeout / 0.1)):
        waiting = open_questions()
        if waiting:
            return waiting[0].id
        await asyncio.sleep(0.1)
    raise AssertionError("the op never raised a question")


async def _drive(frontend: str, action: str, value: str = "") -> dict:
    question_id = await _question_id()
    url = f"{frontend.rstrip('/')}/win/ask/{question_id}"
    done = await asyncio.to_thread(
        functools.partial(
            subprocess.run, [_node_exe() or "node", str(DRIVER), url, action, value],
            cwd=UI, env=_node_env(), capture_output=True, text=True, timeout=120,
        )
    )
    out = (done.stdout or "").strip()
    payload = json.loads(out.splitlines()[-1]) if out else {}
    assert done.returncode == 0, (
        f"browser driver failed (exit {done.returncode})\n"
        f"stdout: {out[:2500]}\nstderr: {(done.stderr or '')[-500:]}"
    )
    return payload


async def _run():
    from flow_sdk.core.compute_op import run_op

    return await run_op(_spec(), trusted=True, workdir=Path(REPO),
                        platform=sys.platform, ask_timeout=ASK_BUDGET)


# ── the matrix, with a live instance and a real window ────────────────────────


async def test_no_tab_listening_takes_the_window_route(_record_browser_opens):
    """The other half of the matrix: nothing is watching, so a window is wanted.

    What is pinned: with no tab, the push is declined and the fall-through is
    reached, at the chrome-less address.

    What is NOT automated, deliberately: the last step of that route calls
    ``flow_service()``, which borrows or STARTS the selected instance — and on
    a developer's machine the selected instance is their real one. A test that
    may start or adopt somebody's running server is not a test worth having.
    Verified by hand instead; the address it would open is asserted here.
    """
    from flow_sdk.core.compute.ask import cancel, open_question
    from flow_sdk.core.compute.ask_window import _push_to_live_tab, ask_url

    question = open_question("get-api-key", "token", {"token": "string"})
    try:
        assert await _push_to_live_tab(question) is False, "no tab was connected, yet one was used"
        assert ask_url("http://127.0.0.1:9007", question.id).endswith(f"/win/ask/{question.id}")
    finally:
        # Leave nothing waiting: the next test's driver answers the FIRST open
        # question, and a leftover would hand it the wrong one.
        cancel(question.id)


async def test_success_a_person_types_a_value_and_the_op_returns_it(frontend):
    """The whole point: typed in a browser, asserted in Python."""
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    running = asyncio.create_task(_run())
    drove = await _drive(frontend, "answer", "sk-live-from-the-browser")
    said = await running

    assert drove["prompt"] == "E2E: type a token", "the window drew the op's own question"
    assert drove["settled"], "the window never confirmed it had sent the answer"
    assert not drove["problems"], f"the page threw: {drove['problems']}"
    assert said.exit_code is ExitCode.OK
    assert said.value.token == "sk-live-from-the-browser", (
        "what the person typed did not come back as the op's value"
    )


async def test_cancel_the_person_declines(frontend):
    """A cancel is an answer: not OK, no value, and nothing blames the machine."""
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    running = asyncio.create_task(_run())
    await _drive(frontend, "cancel")
    said = await running

    assert said.ok is False
    assert said.exit_code is ExitCode.NOT_YET
    assert said.value is None
    assert "cancel" in said.detail.lower()


async def test_fail_a_value_of_the_wrong_shape_is_refused_in_the_window(backend_port):
    """The declared shape holds even with a person on the other end.

    Driven over HTTP rather than through the page because this asserts the
    REFUSAL — a 422 the window shows and the person can correct — and the
    window is where a correctable error should stay, not a failed op.
    """
    running = asyncio.create_task(_run())
    question_id = await _question_id()
    base = f"http://127.0.0.1:{backend_port}"

    async with httpx.AsyncClient(timeout=10.0) as http:
        bad = await http.post(f"{base}/api/v1/ask/{question_id}/answer", json={"value": 12345})
        assert bad.status_code == 422, "a wrong-shaped answer must not reach the op"
        still = await http.get(f"{base}/api/v1/ask/{question_id}")
        assert still.status_code == 200, "the question must stay open to be corrected"
        good = await http.post(f"{base}/api/v1/ask/{question_id}/answer",
                               json={"value": {"token": "corrected"}})
        assert good.status_code == 200

    said = await running
    assert said.ok is True
    assert said.value.token == "corrected"


async def test_fail_nobody_answers_before_the_deadline(frontend):
    """The window is raised and left alone. The op stops waiting and says so."""
    from flow_sdk.core.compute_op import run_op
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    said = await run_op(_spec(), trusted=True, workdir=Path(REPO),
                        platform=sys.platform, ask_timeout=1.0)

    assert said.ok is False
    assert said.exit_code is ExitCode.NOT_YET
    assert "no answer within" in said.detail

"""Turn-end regression for a PTY session viewed in chat — the FLOWPAD-2034 shape.

The transport toggle is **one-directional by design**, and that is the whole
point of this test. Reading the UI rather than the backend seam
(``ui/src/components/terminal/interactive-terminal/use-process-surface.ts``):

  - **→ terminal / advanced** calls ``AgenticProcess.switchMode(Interactive)``,
    which is ``start()`` → ``POST open`` (``agentic-process.ts:2961``). That
    spawns the PTY and persists ``pty_mode: true``.
  - **→ chat / vibe** makes **no lifecycle call at all**. ``useProcessSurface``
    returns early for a non-PTY view mode and only forces a transcript reload
    (``loadHistory({force:true})`` → ``GET get-history``). Chat and vibe render
    the session's stream, which is transport-independent, so nothing kills the
    worker.

So a session that has ever been in the terminal is **pinned to the PTY
transport for life**: coming back to chat leaves ``pty_mode`` TRUE, and every
later chat prompt routes to ``_run_pty_prompt``'s transcript poller instead of
the headless stream-json path. That is the state the reported bug lives in, so
it is the state this test sets up and asserts.

The ``switch-mode`` action exists and does flip ``pty_mode`` to false — but the
view toggle never calls it, so a test that used it would be exercising a path
no user can reach and asserting the opposite of the real invariant.

Scenario:

    create in PTY mode → POST open (the terminal toggle) → back to chat
      → ``pty_mode`` is STILL true
      → a REAL turn: summarize ``agentic_process.py``
      → the turn's result actually exists and the stream ended after it
      → the session CONTINUES: a second turn resumes the same ``session_id``

What is under test is the **turn-end mechanism**, so each turn is drained to EOF
rather than broken out of at the first matching frame. The poller closes the
stream on the vendor's terminal marker, and falls back to closing on transcript
inactivity — and the vendor writes nothing to its JSONL while it thinks,
generates, or runs a tool. A long turn racing that fallback is precisely how
FLOWPAD-2034 lost its tail while still reporting ``outcome="success"``. The
three assertions that carry the meaning are

  1. the assistant's answer reached the client (the marker is inside an
     ``assistant`` chat frame),
  2. a terminal frame (``flow-result`` / ``flow-end``) arrived **after** that
     answer — the turn ended *because it finished*, not before it produced
     anything, and
  3. the next prompt lands on the SAME provider session.

Deterministic on purpose — no agent drives it, no model output is parsed for
meaning. The scenario is fixed, the workdir is fixed (the real 8k-line
``agentic_process.py`` copied in, so the turn does genuine multi-tool work), and
every assertion keys on an exact marker token, a frame name, or an id.

Run — the whole point is a turn long enough to stress the turn boundary, so it
does NOT fit ``pytest.ini``'s 30s cap. No timeout marker is added to this file
(CLAUDE.md forbids raising any budget in code); relax it at the call site:

    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:6007 \\
        uv run pytest tests/long_tests/test_agentic_process_mode_switch_turn_end.py \\
        -v -s --timeout=0
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path

import httpx
import pytest

from tests.long_tests._model_tier import small_model_for
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

# No hardcoded default: a long/e2e test must NEVER silently target the main dev
# backend (its loaded DB makes createProcess pathologically slow and the port is
# environment-specific). Require an explicit dedicated-instance URL.
HUB_URL = os.environ.get("FLOWPAD_HUB_URL")

# worker_type → CLI binary that must be on PATH for that vendor's row to run.
_VENDOR_BINARY = {
    "claude_code": "claude",
    "codex": "codex",
    "copilot": "copilot",
}

#: The file the session is asked to summarize, copied into the throwaway workdir
#: so the turn does real work without the worker sitting in the live checkout.
_TARGET_NAME = "agentic_process.py"
_TARGET_SOURCE = (
    Path(__file__).resolve().parents[2] / "flow_sdk" / "builtin" / "agentic_process" / _TARGET_NAME
)

_SUMMARY_MARKER = "FLOWPAD_SUMMARY_COMPLETE"
_CONTINUE_MARKER = "FLOWPAD_CONTINUE_OK"

_SUMMARY_PROMPT = (
    f"Read the file {_TARGET_NAME} in your current working directory and summarize what it does "
    "in 3 to 5 short bullet points. Then, on the very last line of your reply, write exactly "
    f"{_SUMMARY_MARKER} and nothing else on that line."
)
_CONTINUE_PROMPT = (
    "Do not read any file again. Answering only from the summary you just wrote, name the main "
    "class that file defines. Then, on the very last line of your reply, write exactly "
    f"{_CONTINUE_MARKER} and nothing else on that line."
)

#: Floor for "a result actually exists" on the SUMMARY turn — a bare marker echo
#: with no summary in front of it is a truncated turn wearing the right last line.
#: It applies to that turn only: the follow-up asks for a single class name, and a
#: correct answer there is legitimately a few words long.
_MIN_SUMMARY_CHARS = 120


@pytest.fixture
async def hub_and_node():
    """Yields (httpx.AsyncClient, compute_node_id). Skips if hub isn't reachable."""
    if not HUB_URL:
        pytest.skip(
            "FLOWPAD_HUB_URL not set — point this e2e test at a DEDICATED instance "
            "(scripts/instance_ctl.sh launch <name>), never the main dev backend."
        )
    # Same client budget as test_agentic_process_prompt_streaming — the read
    # timeout is a per-chunk gap, and a live turn paints status frames well
    # inside it. Nothing here is tuned to make a symptom go away.
    client = httpx.AsyncClient(base_url=HUB_URL, timeout=httpx.Timeout(10.0, read=120.0))
    try:
        try:
            r = await client.get("/api/v1/graph/bootstrap", params={"domain": "localhost"})
        except httpx.ConnectError:
            await client.aclose()
            pytest.skip(f"hub not reachable at {HUB_URL}")
        if r.status_code != 200:
            await client.aclose()
            pytest.skip(f"hub bootstrap {r.status_code}")
        data = r.json().get("data") or {}
        node = data.get("default_compute_node") or {}
        cnid = node.get("id")
        if not cnid:
            await client.aclose()
            pytest.skip("no default compute node in bootstrap")
        yield client, cnid
    finally:
        await client.aclose()


def _require_binary(worker_type: str) -> None:
    binary = _VENDOR_BINARY[worker_type]
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} CLI not installed — skipping {worker_type}")


def _real_home() -> Path:
    """The user's home, not the pytest sandbox one.

    ``tests/conftest.py`` swaps ``HOME`` to a sandbox tempdir before flow_sdk is
    imported and stashes the original in ``FLOWPAD_PRE_SANDBOX_HOME``. The vendor
    CLIs run in the *backend* process, so they read the real home — any consent
    this test records must land there too.
    """
    return Path(os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or os.path.expanduser("~"))


def _trust_workdir_for_claude(workdir: str) -> None:
    """Record Claude's directory-trust consent for ``workdir``.

    Claude's TUI opens a blocking "1. Yes, I trust this folder" interstitial the
    first time it launches in an unseen directory, and every prompt in this test
    is typed into that TUI's composer — a prompt typed while the interstitial
    owns the screen is eaten, and the turn dies as ``user-turn-not-landed`` long
    before reaching the turn boundary under test.

    This is CLI *consent* state, the same category as ``~/.claude/.credentials.json``
    (which this suite's conftest already preserves). Codex and Copilot persist the
    equivalent through their own drivers (``_interactive_trust_flags`` /
    ``COPILOT_ALLOW_ALL``), so only Claude needs it written here.
    """
    path = _real_home() / ".claude.json"
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    projects = blob.setdefault("projects", {})
    for key in {workdir, workdir.replace("/", "\\"), workdir.replace("\\", "/")}:
        entry = projects.setdefault(key, {})
        entry["hasTrustDialogAccepted"] = True
        entry["hasCompletedProjectOnboarding"] = True
        entry["projectOnboardingSeenCount"] = 2
    path.write_text(json.dumps(blob, indent=2), encoding="utf-8")


def _prepare_workdir(tmp_path: Path) -> str:
    """Throwaway workdir holding the real ``agentic_process.py``.

    Copied rather than pointing the worker at the checkout: the turn runs with
    ``bypassPermissions``, and a summarize prompt has no business being able to
    write to the tree the test is validating.
    """
    assert _TARGET_SOURCE.is_file(), f"summary target missing: {_TARGET_SOURCE}"
    workdir = tmp_path / "turn_end"
    workdir.mkdir()
    shutil.copyfile(_TARGET_SOURCE, workdir / _TARGET_NAME)
    return str(workdir)


async def _get_process(hub_client, process_id: str) -> dict:
    r = await hub_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert r.status_code == 200, f"get process {r.status_code}: {r.text[:300]}"
    return r.json().get("data") or r.json()


async def _create_pty_process(hub_client, compute_node_id: str, workdir: str, worker_type: str) -> dict:
    """Create the process the way the UI's "new terminal session" does."""
    context = {
        "workdir": workdir,
        "worker_type": worker_type,
        "permission_mode": "bypassPermissions",
        "model": small_model_for(worker_type),
    }
    body = {"context": context, "visible": True, "pty_mode": True}
    r = await hub_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json=body,
    )
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:400]}"
    pid = (r.json().get("data") or r.json())["id"]
    # GET independently: createProcess returns its own projection, and what the
    # next step acts on is the persisted row.
    return await _get_process(hub_client, pid)


async def _await_worker_ready(hub_client, process_id: str, worker_type: str) -> dict:
    """Poll the ``status`` action until the PTY can take input.

    Waiting for a precondition, not widening one: the footer toggle is itself
    gated on ``is_ready_for_input`` (``useProcessSurface`` bails on
    ``!awaitingUserInput``), and a booting worker reads as busy. Bounded so a
    worker that never comes up fails the test instead of hanging it.
    """
    last: dict = {}
    for _ in range(60):
        r = await hub_client.get(f"/api/v1/graph/agentic_process/{process_id}/status")
        assert r.status_code == 200, f"status {r.status_code}: {r.text[:300]}"
        last = r.json().get("data") or r.json()
        if last.get("ready_for_input") is True:
            return last
        if last.get("worker_status") in {"error", "api_error"}:
            pytest.skip(
                f"{worker_type} PTY worker came up in {last.get('worker_status')!r} "
                f"(vendor auth / quota, not a transport defect): {last}"
            )
        await asyncio.sleep(1.0)
    raise AssertionError(
        f"{worker_type}: PTY worker never became ready for input; last status={last}"
    )


async def _enter_terminal_mode(hub_client, process_id: str) -> dict:
    """The footer toggle's →terminal direction.

    ``switchMode(WorkerMode.Interactive)`` is ``start({visible, retry})`` →
    ``POST open`` (``ts_sdk/src/process/agentic-process.ts``), NOT the
    ``switch-mode`` action — that action's CLI branch is only ever reached by
    non-UI callers. ``start_pty`` is documented idempotent on a live PTY
    ("detects alive PTY and returns without re-spawning"), which is what makes
    this safe to call on a session already in PTY mode.
    """
    r = await hub_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
        json={"visible": True, "retry": True},
    )
    assert r.status_code == 200, f"open {r.status_code}: {r.text[:400]}"
    return r.json().get("data") or r.json()


async def _return_to_chat(hub_client, process_id: str) -> None:
    """The footer toggle's →chat/vibe direction — a transcript reload, nothing more.

    ``useProcessSurface`` returns early for a non-PTY view mode: no ``exit``, no
    ``switch-mode``, no transport mutation of any kind. Its ONE backend call is
    ``loadHistory({force: true})`` → ``GET get-history``. Modelling that call
    (rather than skipping the step) is what keeps this test honest about the
    invariant it then asserts: the worker survives, and so does ``pty_mode``.
    """
    r = await hub_client.get(f"/api/v1/graph/agentic_process/{process_id}/get-history")
    assert r.status_code == 200, f"get-history {r.status_code}: {r.text[:300]}"


def _assistant_text(xml: str) -> str:
    """Every ``assistant`` chat frame's body, concatenated in arrival order."""
    return "\n".join(
        re.findall(
            r'<flow-chat\b(?=[^>]*\brole="assistant")[^>]*>(.*?)</flow-chat>',
            xml,
            re.S,
        )
    )


#: The vendor's own words for "this CLI has no usable credentials". Matched only
#: inside a ``flow-error`` frame the driver lifted from the CLI's error event.
_AUTH_FAILURE_PATTERNS = (
    "401 unauthorized",
    "missing bearer or basic authentication",
    "not logged in",
    "please run /login",
    "invalid api key",
)


def _skip_if_worker_unavailable(xml: str, worker_type: str) -> None:
    """Skip when the PROVIDER says it cannot serve the turn.

    Two shapes, both keyed on a frame the driver lifted from the vendor's OWN
    error event — never on a merely missing reply, so a real transport or
    turn-end regression still fails red:

      - ``flow-worker-unavailable`` — account quota / rate limit.
      - a ``flow-error`` carrying an authentication failure — the CLI is not
        logged in on this machine (``codex login`` / ``claude /login`` never
        run). No turn can be served at all, so there is nothing to conclude
        about where a turn ends.
    """
    match = re.search(r"<flow-worker-unavailable\b[^>]*>.*?</flow-worker-unavailable>", xml, re.S)
    if match is not None:
        pytest.skip(
            f"{worker_type} CLI is provider-unavailable (account quota / rate limit) — "
            f"external infra, not a turn-end regression: {match.group(0)[:300]}"
        )
    for error in re.findall(r"<flow-error\b[^>]*>(.*?)</flow-error>", xml, re.S):
        lowered = error.lower()
        if any(pattern in lowered for pattern in _AUTH_FAILURE_PATTERNS):
            pytest.skip(
                f"the {worker_type} CLI is not authenticated on this machine — log it in and "
                f"re-run; nothing here is a turn-end regression: {error[:300]}"
            )


async def _drain_turn(hub_client, process_id: str, message: str, worker_type: str) -> str:
    """Send a prompt and read its stream to EOF; retries only the in-flight 409.

    Draining to EOF is the point: on the PTY transport the poller decides when
    the turn is over (vendor terminal marker, else transcript inactivity), so
    the server closing the stream IS the mechanism under test. Stopping at the
    first frame we like would hide a turn cut off mid-flight. The 409 retry
    covers the previous turn still releasing the per-process prompt lock, and is
    bounded.
    """
    for _ in range(20):
        received = b""
        async with hub_client.stream(
            "POST",
            f"/api/v1/graph/agentic_process/{process_id}/prompt",
            json={"message": message},
        ) as r:
            if r.status_code == 409:
                text = (await r.aread()).decode()
                if "already in flight" in text:
                    await asyncio.sleep(1.0)
                    continue
                raise AssertionError(f"prompt 409 (not an in-flight race): {text[:300]}")
            assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:300]}"
            async for chunk in r.aiter_bytes():
                received += chunk
        return received.decode("utf-8", errors="replace")
    raise AssertionError(f"prompt never admitted on {process_id} — the prompt lock was never released")


def _assert_turn_ended_after_its_answer(
    xml: str, marker: str, worker_type: str, label: str, min_chars: int = 0
) -> str:
    """The three turn-end facts, in the order they have to hold."""
    answer = _assistant_text(xml)
    frames = re.findall(r"<flow-([a-z-]+)", xml)

    assert marker in answer, (
        f"{worker_type}/{label}: the assistant's answer never reached the client — the turn was "
        f"cut off before it finished. frames={frames} answer={answer[:300]!r}"
    )
    assert len(answer.strip()) >= min_chars, (
        f"{worker_type}/{label}: only {len(answer.strip())} chars of assistant content — a marker "
        f"with no result in front of it. answer={answer[:300]!r}"
    )

    terminal = [m.start() for m in re.finditer(r"<flow-(?:end|result)\b", xml)]
    assert terminal, f"{worker_type}/{label}: the stream closed with no terminal frame. frames={frames}"
    last_marker = xml.rfind(marker)
    assert terminal[-1] > last_marker, (
        f"{worker_type}/{label}: the turn ended BEFORE its answer landed "
        f"(terminal frame at {terminal[-1]}, answer at {last_marker}). frames={frames}"
    )
    return answer


async def _settle_session_id(hub_client, process_id: str) -> str | None:
    """Poll the process row until a session_id is persisted (or give up)."""
    for _ in range(15):
        row = await _get_process(hub_client, process_id)
        if row.get("session_id"):
            return row["session_id"]
        await asyncio.sleep(1.0)
    return None


async def _full_transcript(hub_client, process_id: str) -> dict:
    r = await hub_client.post(f"/api/v1/graph/agentic_process/{process_id}/transcript/full", json={})
    assert r.status_code == 200, f"transcript/full {r.status_code}: {r.text[:300]}"
    return r.json().get("data") or r.json()


def _assert_persisted_answer(transcript: dict, prompt: str, marker: str, worker_type: str) -> None:
    """The answer is in the session's own history, not only on the wire.

    A stream can carry frames the provider session never committed; a result the
    NEXT turn can build on has to be a real transcript row after its user row.
    """
    entries = [e for e in transcript.get("entries") or [] if not e.get("is_sidechain")]
    user_index = next(
        (
            index
            for index, entry in enumerate(entries)
            if entry.get("kind") == "user_message"
            and not entry.get("is_meta")
            and prompt.strip() in str(entry.get("text") or "")
        ),
        None,
    )
    assert user_index is not None, (
        f"{worker_type}: the user turn was never recorded in the session transcript; "
        f"kinds={[e.get('kind') for e in entries][:20]}"
    )
    assert any(
        entry.get("kind") == "assistant_message" and marker in str(entry.get("text") or "")
        for entry in entries[user_index + 1 :]
    ), (
        f"{worker_type}: no assistant transcript row carrying {marker} after the user turn — "
        f"the result exists on the wire but not in the session"
    )


@pytest.mark.parametrize("worker_type", ["claude_code", "codex", "copilot"])
async def test_chat_turn_on_a_pty_pinned_session_ends_with_a_result_and_continues(
    hub_and_node, tmp_path, worker_type
):
    """PTY session → terminal → back to chat (still PTY) → a real turn ends with a result."""
    _require_binary(worker_type)
    hub_client, compute_node_id = hub_and_node
    workdir = _prepare_workdir(tmp_path)
    _trust_workdir_for_claude(workdir)

    # ── 1. a new session in PTY mode ─────────────────────────────────────────
    process = await _create_pty_process(hub_client, compute_node_id, workdir, worker_type)
    process_id = process["id"]
    assert process.get("pty_mode") is True, f"pty_mode not persisted: {process.get('pty_mode')}"
    assert process.get("shell_id"), (
        "createProcess(visible=True) must spawn the PTY worker — without a live shell there is "
        "no terminal to come back from"
    )
    await _await_worker_ready(hub_client, process_id, worker_type)

    # ── 2. the terminal / advanced surface (the toggle's POST open) ──────────
    opened = await _enter_terminal_mode(hub_client, process_id)
    assert (await _get_process(hub_client, process_id)).get("pty_mode") is True, (
        f"open must leave the session on the PTY transport: {opened}"
    )
    await _await_worker_ready(hub_client, process_id, worker_type)

    # ── 3. back to chat / vibe — and the session stays PTY-pinned ────────────
    await _return_to_chat(hub_client, process_id)
    row = await _get_process(hub_client, process_id)
    assert row.get("pty_mode") is True, (
        "returning to chat must NOT clear pty_mode — the toggle is one-directional "
        "(useProcessSurface returns early for chat/vibe), so the session stays on the PTY "
        f"transport and the next prompt routes to _run_pty_prompt. got {row.get('pty_mode')}"
    )
    assert row.get("shell_id"), "returning to chat must not kill the PTY worker"

    # ── 4. a real chat turn, over the PTY transport ─────────────────────────
    xml = await _drain_turn(hub_client, process_id, _SUMMARY_PROMPT, worker_type)
    _skip_if_worker_unavailable(xml, worker_type)

    # ── 5. the result actually exists, and the turn ended after it ───────────
    _assert_turn_ended_after_its_answer(
        xml, _SUMMARY_MARKER, worker_type, "summary", min_chars=_MIN_SUMMARY_CHARS
    )

    session_id = await _settle_session_id(hub_client, process_id)
    assert session_id, f"{worker_type}: the finished turn established no session_id"
    _assert_persisted_answer(
        await _full_transcript(hub_client, process_id), _SUMMARY_PROMPT, _SUMMARY_MARKER, worker_type
    )

    # ── 6. continue ──────────────────────────────────────────────────────────
    xml2 = await _drain_turn(hub_client, process_id, _CONTINUE_PROMPT, worker_type)
    _skip_if_worker_unavailable(xml2, worker_type)
    _assert_turn_ended_after_its_answer(xml2, _CONTINUE_MARKER, worker_type, "continue")

    assert await _settle_session_id(hub_client, process_id) == session_id, (
        f"{worker_type}: the follow-up turn started a fresh provider session instead of resuming "
        f"{session_id} — the PTY-pinned session cannot be continued"
    )

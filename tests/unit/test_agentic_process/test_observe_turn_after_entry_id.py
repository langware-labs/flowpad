"""``observe_turn(after_entry_id=...)`` — the client states its own position.

``observe_turn`` watermarks at OPEN by default: everything already on disk when
the stream is opened counts as history, on the assumption that the caller's pane
loaded it on mount. That holds when mount and open coincide (a second tab
opening mid-turn) and fails when a client learns about a turn late — a prompt
drained from the queue, where the pane mounted before the turn existed, so the
turn's own head is silently classified as history.

``after_entry_id`` lets the client say what it actually holds; the stream then
resumes after that entry. These tests pin all three paths: the default is
unchanged, a known id resumes strictly after itself, and an unknown id degrades
to the default rather than replaying the session.

No mocks: a real JSONL under the real (test-sandboxed) ``claude_projects_dir``,
read back through the real transcript parser, streamed through the real action.

Stated proxy: each case asserts on WHAT the stream delivered within a bounded
drain, not on the stream's closure semantics — those are untouched by the
parameter. The one exception is the SHORT-TURN case, where closing IS the
behaviour under test: that stream has no turn to follow and must hand over the
backlog and end.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.transcript_analyzer import AgentTranscriptFile

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_CWD = "/tmp/flowpad-observe-after-entry"
_DRAIN_BUDGET = 6.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _env(session_id: str) -> dict:
    return {"sessionId": session_id, "cwd": _CWD, "version": "2.0.0"}


def _append(path: Path, *entries: dict) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry) + "\n")


def _user(session_id: str, text: str) -> dict:
    return {
        **_env(session_id), "type": "user", "uuid": str(uuid.uuid4()),
        "timestamp": _now_iso(), "message": {"role": "user", "content": text},
    }


def _assistant(session_id: str, text: str, stop_reason: str | None) -> dict:
    return {
        **_env(session_id), "type": "assistant", "uuid": str(uuid.uuid4()),
        "timestamp": _now_iso(),
        "message": {"role": "assistant", "stop_reason": stop_reason,
                    "content": [{"type": "text", "text": text}]},
    }


async def _session_with_an_unseen_turn_head() -> tuple[AgenticProcess, Path, str]:
    """A PTY session whose CURRENT turn is already underway on disk.

    Two settled exchanges (what a mounted pane would have loaded), then the
    turn's own head — the prompt and its first output — written BEFORE any
    client can open the stream. That ordering is the real one: ``busy`` reaches
    a client from the debounced transcript flush, always after these writes.
    """
    session_id = str(uuid.uuid4())
    project_dir = get_instance_settings().claude_projects_dir / _CWD.replace("/", "-")
    project_dir.mkdir(parents=True, exist_ok=True)
    path = project_dir / f"{session_id}.jsonl"
    path.write_text("", encoding="utf-8")
    _append(
        path,
        _user(session_id, "earlier question"),
        _assistant(session_id, "earlier answer", "end_turn"),
    )
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=session_id,
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = True
    await ap.save(notify=False)
    _append(
        path,
        _user(session_id, "DRAINED-PROMPT"),
        _assistant(session_id, "HEAD-OUTPUT", None),
    )
    return ap, path, session_id


async def _session_whose_turn_already_ended() -> tuple[AgenticProcess, Path, str]:
    """The same unseen turn head — but the turn is FINISHED before the open.

    A short turn is over in well under the transcript flush's debounce, and
    ``busy`` only reaches a client from that flush, so by the time the client
    opens its observation there is nothing left running. Everything the client
    has never seen is already on disk; the open is a handover, not a follow.
    """
    ap, path, session_id = await _session_with_an_unseen_turn_head()
    _append(path, _assistant(session_id, "TAIL-OUTPUT", "end_turn"))
    assert not is_turn_busy(ap), "guard: this fixture must model a turn that is already over"
    return ap, path, session_id


async def _drain(ap: AgenticProcess, **kwargs) -> str:
    """Open the stream and read it to CLOSE (no writer, no finisher task)."""
    response = await ap.observe_turn(**kwargs)
    chunks: list[str] = []

    async def _pump() -> None:
        async for chunk in response.body_iterator:
            chunks.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace"))

    await asyncio.wait_for(_pump(), timeout=_DRAIN_BUDGET)
    return "".join(chunks)


def _entry_ids(path: Path, session_id: str) -> list[str]:
    tf = AgentTranscriptFile("claude", path, session_id=session_id, transcript_format=None)
    return [entry.id for entry in tf.entries]


async def _observe(ap: AgenticProcess, path: Path, session_id: str, **kwargs) -> str:
    """Open the stream, let the turn finish under it, return everything sent."""
    response = await ap.observe_turn(**kwargs)

    async def _finish_the_turn() -> None:
        await asyncio.sleep(0.6)
        _append(path, _assistant(session_id, "TAIL-OUTPUT", "end_turn"))

    finisher = asyncio.create_task(_finish_the_turn())
    chunks: list[str] = []

    async def _pump() -> None:
        async for chunk in response.body_iterator:
            chunks.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace"))

    try:
        await asyncio.wait_for(_pump(), timeout=_DRAIN_BUDGET)
    except asyncio.TimeoutError:
        pass
    await finisher
    return "".join(chunks)


@pytest.mark.long  # 6.01s
@pytest.mark.asyncio
async def test_without_an_entry_id_the_stream_still_watermarks_at_open(
    initialize_test_db,
) -> None:
    """The default is unchanged: the turn's head counts as history."""
    ap, path, session_id = await _session_with_an_unseen_turn_head()

    body = await _observe(ap, path, session_id)

    assert "DRAINED-PROMPT" not in body
    assert "HEAD-OUTPUT" not in body
    assert "TAIL-OUTPUT" in body, "only what the turn appends after open is sent"


@pytest.mark.long  # 6.01s
@pytest.mark.asyncio
async def test_an_entry_id_resumes_the_stream_after_that_entry(
    initialize_test_db,
) -> None:
    """The client says what it holds; the turn's head is no longer lost."""
    ap, path, session_id = await _session_with_an_unseen_turn_head()
    last_entry_the_client_holds = _entry_ids(path, session_id)[1]  # "earlier answer"

    body = await _observe(ap, path, session_id, after_entry_id=last_entry_the_client_holds)

    assert "earlier answer" not in body, "resumes AFTER the stated entry, never replays it"
    assert "DRAINED-PROMPT" in body
    assert "HEAD-OUTPUT" in body
    assert "TAIL-OUTPUT" in body


@pytest.mark.long  # 6.02s
@pytest.mark.asyncio
async def test_an_unknown_entry_id_degrades_to_the_open_watermark(
    initialize_test_db,
) -> None:
    """A stale, rotated or foreign id behaves like today — never a full replay."""
    ap, path, session_id = await _session_with_an_unseen_turn_head()

    body = await _observe(ap, path, session_id, after_entry_id="not-a-real-entry-id")

    assert "earlier question" not in body, "an unknown id must not flood the pane"
    assert "DRAINED-PROMPT" not in body
    assert "HEAD-OUTPUT" not in body
    assert "TAIL-OUTPUT" in body


@pytest.mark.asyncio
async def test_a_turn_that_ended_before_the_open_still_hands_over_its_backlog(
    initialize_test_db,
) -> None:
    """A SHORT turn is over before the client can open its observation.

    ``busy`` is broadcast from the DEBOUNCED transcript flush, so a turn shorter
    than that debounce has already ended by the time the client reacts to it.
    Gating the stream on ``is_turn_busy`` at open therefore discards the position
    the client just stated and closes empty — the drained prompt and its answer
    reach the pane only on a manual refresh (PR #354 review). What the client
    has not seen is on disk; the open is a HANDOVER, not a follow.
    """
    ap, path, session_id = await _session_whose_turn_already_ended()
    last_entry_the_client_holds = _entry_ids(path, session_id)[1]  # "earlier answer"

    body = await _drain(ap, after_entry_id=last_entry_the_client_holds)

    assert "DRAINED-PROMPT" in body
    assert "HEAD-OUTPUT" in body
    assert "TAIL-OUTPUT" in body
    assert "earlier answer" not in body, "still resumes AFTER the stated entry"


@pytest.mark.asyncio
async def test_a_backlog_only_stream_closes_instead_of_polling_for_a_dead_turn(
    initialize_test_db,
) -> None:
    """Closure is the behaviour under test here, not a proxy.

    There is no turn to follow, and the PTY liveness check needs a provider
    marker this stream can never see (it was written before the open). The
    backlog pass must end the stream itself — ``_drain`` reads to close under
    the same bounded budget the other cases use, so a stream that kept polling
    fails here as a timeout.
    """
    ap, path, session_id = await _session_whose_turn_already_ended()

    await _drain(ap, after_entry_id=_entry_ids(path, session_id)[1])


@pytest.mark.asyncio
async def test_nothing_running_and_nothing_unseen_is_an_empty_closed_stream(
    initialize_test_db,
) -> None:
    """The original no-op path is intact: a caller racing the end of a turn with
    its position already at the tail gets an empty, closed stream — not an
    error, and not a replay."""
    ap, path, session_id = await _session_whose_turn_already_ended()

    body = await _drain(ap, after_entry_id=_entry_ids(path, session_id)[-1])

    assert body == ""


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.live_frame_identity.rules: FAILING? the wire lost transcript-entry-id
#       - read this tag's rules before touching entry_to_flowdata or to_xml
# flowpad:endcapsule tag
@pytest.mark.long  # 6.01s
@pytest.mark.asyncio
async def test_the_stream_names_the_entry_each_frame_came_from(
    initialize_test_db,
) -> None:
    """A client can only advance its position if the frames say what they are.

    ``process_entry`` does NOT survive ``FlowData.to_xml`` — that writes
    attributes and content only — so before the ``transcript-entry-id``
    attribute every live frame reached the client anonymous. Its
    ``lastHeldTranscriptEntryId`` could then only ever return the last entry
    HISTORY gave it, so each re-open re-stated that stale position and the
    stream replayed everything written since (FLOWPAD-1981).

    Known limit, deliberately not asserted here: the streaming handler merges
    CONSECUTIVE same-element-type entries into one element, and a start tag's
    attributes are fixed when it opens — so a run of several assistant entries
    is named by its FIRST entry. Alternating user/assistant turns (the queue
    drain this ticket is about) give every entry its own element.
    """
    ap, path, session_id = await _session_with_an_unseen_turn_head()
    ids = _entry_ids(path, session_id)

    body = await _observe(ap, path, session_id, after_entry_id=ids[1])

    assert "DRAINED-PROMPT" in body, "guard: the turn head is being streamed at all"
    named = [entry_id for entry_id in ids if entry_id in body]
    assert ids[2] in named, (
        f"the streamed prompt must name its own entry so a client can resume "
        f"after it instead of re-stating its history position; named={named}"
    )
    assert ids[3] in named, (
        f"...and so must the assistant frame that follows it; named={named}"
    )

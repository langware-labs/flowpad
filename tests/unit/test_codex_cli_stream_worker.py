"""Unit tests for CodexCLIStreamWorker.

Mirrors ``tests/unit/test_copilot_cli_stream_worker.py`` — a fake-argv worker
whose ``_build_spawn`` is monkeypatched to a shell that ``printf``s canned
JSONL lines. No real ``codex`` binary is touched.

Two behaviours specific to codex are pinned here:

- **session-id capture from ``thread.started``** — the worker records the
  ``thread_id`` of the FIRST ``thread.started`` event onto ``self._session_id``
  (``codex/stream_worker.py`` ~:146). A second ``thread.started`` in the same
  stream does NOT overwrite it.
- **the fresh-id-every-turn hazard** — codex mints its OWN rollout id per run;
  in a headless multi-turn where no rollout persists, the driver builds a fresh
  ``CodexCLIStreamWorker`` per turn and each turn captures a DIFFERENT id. These
  tests pin that documented behaviour at the worker level (the driver's
  ``has_resumable_session`` gate is what suppresses it when a rollout survives —
  see ``tests/unit/test_cli_driver_contract.py``).
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    WorkerSpawnError,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex import (
    CANCEL_GRACE_SECONDS,
    CodexCLIStreamWorker,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from tests.utils.fake_cli import (
    clear_harness_capability,
    fake_stream_argv,
    make_fake_cli_bin,
    patch_build_spawn,
    seed_harness_capability,
)

# ``_build_spawn`` takes ``(context, prompt)`` and returns a 3-tuple
# ``(argv, env, stdin)`` — codex delivers the prompt over the child's stdin
# (PROMPT_CHANNEL="stdin"). ``patch_build_spawn(..., stdin="")`` reproduces that
# 3-tuple shape; the stdin body is ignored by the bash fake.


async def _collect(worker: CodexCLIStreamWorker, context: AgenticContext) -> list:
    return [fd async for fd in worker.execute(prompt="hi", context=context)]


THREAD_STARTED = {
    "type": "thread.started",
    "thread_id": "019dddd0-1234-7000-9000-000000000001",
    "timestamp": "2026-05-06T21:39:48.000Z",
}
TURN_COMPLETED = {
    "type": "turn.completed",
    "usage": {"input_tokens": 3, "output_tokens": 5},
    "timestamp": "2026-05-06T21:39:50.000Z",
}


# ── D02: spawn must use the capability-discovered executable, not the service
# PATH. The QA repro is a backend launched with a PATH that excludes the nvm
# bin dir while capability discovery recorded it.

_STRIPPED_SERVICE_PATH = os.pathsep.join(["/usr/bin", "/bin"])


def test_build_spawn_uses_absolute_discovered_codex_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    bin_dir, codex = make_fake_cli_bin(tmp_path, "codex")
    monkeypatch.setenv("PATH", _STRIPPED_SERVICE_PATH)  # service PATH lacks nvm dir
    seed_harness_capability(monkeypatch, "codex", bin_dir)

    argv, env, stdin = CodexCLIStreamWorker()._build_spawn(AgenticContext(workdir=str(tmp_path)), "hello")

    assert argv[0] == str(codex)
    assert env["PATH"].split(os.pathsep)[0] == str(bin_dir)
    assert stdin == "hello"


def test_build_spawn_survives_worker_env_path_pin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The exact D02 scenario: every headless turn's context env_vars carry a
    PATH (``apply_worker_env`` pins the backend venv, built from the SAME
    stripped service PATH). That overlay must not clobber the discovered bin
    dir — argv[0] still resolves to the absolute discovered executable."""
    bin_dir, codex = make_fake_cli_bin(tmp_path, "codex")
    monkeypatch.setenv("PATH", _STRIPPED_SERVICE_PATH)
    seed_harness_capability(monkeypatch, "codex", bin_dir)
    venv_bin = str(tmp_path / "venv-bin")
    pinned_path = f"{venv_bin}{os.pathsep}{_STRIPPED_SERVICE_PATH}"  # apply_worker_env shape

    ctx = AgenticContext(workdir=str(tmp_path), env_vars={"PATH": pinned_path})
    argv, env, stdin = CodexCLIStreamWorker()._build_spawn(ctx, "hello")

    assert argv[0] == str(codex)
    path_dirs = env["PATH"].split(os.pathsep)
    assert path_dirs[0] == str(bin_dir)  # discovered dir stays first
    assert venv_bin in path_dirs  # the flow-CLI pin survives


def test_build_spawn_missing_binary_raises_typed_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Discovery recorded a folder, but the binary is gone (uninstalled since).
    empty_dir = tmp_path / "empty-bin"
    empty_dir.mkdir()
    monkeypatch.setenv("PATH", _STRIPPED_SERVICE_PATH)
    seed_harness_capability(monkeypatch, "codex", empty_dir)

    with pytest.raises(WorkerSpawnError, match=r"codex executable .* not found on worker PATH"):
        CodexCLIStreamWorker()._build_spawn(AgenticContext(workdir=str(tmp_path)), "hello")


def test_build_spawn_no_capability_raises_typed_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    clear_harness_capability(monkeypatch, "codex")
    # Pin another vendor as installed: `no_worker_message` falls back to a
    # generic "nothing is installed" when NO vendor resolves, so on a bare CI
    # image this asserted the wrong branch. See the twin in the claude worker test.
    seed_harness_capability(monkeypatch, "claude", make_fake_cli_bin(tmp_path, "claude"))

    with pytest.raises(WorkerSpawnError, match=r"no harness\.codex\.cli installation discovered"):
        CodexCLIStreamWorker()._build_spawn(AgenticContext(workdir=str(tmp_path)), "hello")


@pytest.mark.asyncio
async def test_session_id_captured_from_thread_started(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(
        monkeypatch, CodexCLIStreamWorker, fake_stream_argv([THREAD_STARTED, TURN_COMPLETED], delay_ms=2), stdin=""
    )

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert worker.get_session_id() == "019dddd0-1234-7000-9000-000000000001"


@pytest.mark.asyncio
async def test_first_thread_started_wins_within_a_stream(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # The ``self._session_id is None`` guard means only the FIRST thread.started
    # sets the id; a later one in the same stream is ignored.
    second = {
        "type": "thread.started",
        "thread_id": "aaaaaaaa-0000-7000-9000-000000000002",
        "timestamp": "2026-05-06T21:39:49.000Z",
    }
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        fake_stream_argv([THREAD_STARTED, second, TURN_COMPLETED], delay_ms=2),
        stdin="",
    )

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert worker.get_session_id() == "019dddd0-1234-7000-9000-000000000001"


@pytest.mark.asyncio
async def test_fresh_id_every_turn_hazard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Documented hazard: with no persisted rollout, the driver builds a fresh
    # worker per turn and each turn captures whatever id its own thread.started
    # carries. Two fresh workers fed different ``thread.started`` events capture
    # two different ids — i.e. session continuity is NOT preserved by the worker
    # alone; it relies on the rollout + ``has_resumable_session`` resume gate.
    turn1_id = "019dddd0-1234-7000-9000-000000000001"
    turn2_id = "bbbbbbbb-0000-7000-9000-000000000003"

    w1 = CodexCLIStreamWorker(transcript_path=tmp_path / "t1.jsonl")
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        fake_stream_argv([{**THREAD_STARTED, "thread_id": turn1_id}, TURN_COMPLETED], delay_ms=2),
        stdin="",
    )
    await _collect(w1, AgenticContext(workdir=str(tmp_path)))

    w2 = CodexCLIStreamWorker(transcript_path=tmp_path / "t2.jsonl")
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        fake_stream_argv([{**THREAD_STARTED, "thread_id": turn2_id}, TURN_COMPLETED], delay_ms=2),
        stdin="",
    )
    await _collect(w2, AgenticContext(workdir=str(tmp_path)))

    assert w1.get_session_id() == turn1_id
    assert w2.get_session_id() == turn2_id
    assert w1.get_session_id() != w2.get_session_id()


@pytest.mark.asyncio
async def test_turn_completed_yields_result_and_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(
        monkeypatch, CodexCLIStreamWorker, fake_stream_argv([THREAD_STARTED, TURN_COMPLETED], delay_ms=2), stdin=""
    )

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))
    types = [fd.attributes["element-type"] for fd in out]

    assert FlowElementType.RESULT in types
    assert types[-1] == FlowElementType.END


@pytest.mark.asyncio
async def test_single_jsonl_event_larger_than_asyncio_default_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    oversized_started = {**THREAD_STARTED, "payload": "x" * (96 * 1024)}
    assert len(json.dumps(oversized_started).encode("utf-8")) > 64 * 1024

    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        fake_stream_argv([oversized_started, TURN_COMPLETED], delay_ms=2),
        stdin="",
    )

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))
    types = [fd.attributes["element-type"] for fd in out]

    assert worker.get_session_id() == THREAD_STARTED["thread_id"]
    assert FlowElementType.RESULT in types
    assert types[-1] == FlowElementType.END


@pytest.mark.asyncio
async def test_stream_is_teed_to_transcript(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    transcript = tmp_path / "codex.jsonl"
    worker = CodexCLIStreamWorker(transcript_path=transcript)
    patch_build_spawn(
        monkeypatch, CodexCLIStreamWorker, fake_stream_argv([THREAD_STARTED, TURN_COMPLETED], delay_ms=2), stdin=""
    )

    await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    text = transcript.read_text(encoding="utf-8")
    assert '"type": "thread.started"' in text
    assert '"type": "turn.completed"' in text
    assert worker.manages_history() is True


@pytest.mark.asyncio
async def test_missing_binary_yields_error_frame_then_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # An unresolvable binary surfaces on BOTH channels: an ERROR frame on the
    # chat stream (so the user sees the message) and a typed WorkerSpawnError
    # out of the generator (so the turn runner latches status=FAILED +
    # start_failure instead of ending the turn look-successful).
    empty_dir = tmp_path / "empty-bin"
    empty_dir.mkdir()
    monkeypatch.setenv("PATH", _STRIPPED_SERVICE_PATH)
    seed_harness_capability(monkeypatch, "codex", empty_dir)
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")

    out = []
    with pytest.raises(WorkerSpawnError, match="not found on worker PATH"):
        async for fd in worker.execute(prompt="hi", context=AgenticContext(workdir=str(tmp_path))):
            out.append(fd)

    types = [fd.attributes["element-type"] for fd in out]
    assert types == [FlowElementType.ERROR]
    assert "not found on worker PATH" in out[0].flow_value


@pytest.mark.asyncio
async def test_headless_prompt_missing_binary_ends_process_failed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Driver-level D02 contract: a headless turn whose codex executable can't
    be resolved must end the process FAILED with the start_failure latch (not
    crash, not stay RUNNING with an empty transcript)."""
    from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    empty_dir = tmp_path / "empty-bin"
    empty_dir.mkdir()
    monkeypatch.setenv("PATH", _STRIPPED_SERVICE_PATH)
    seed_harness_capability(monkeypatch, "codex", empty_dir)
    monkeypatch.setattr(
        CodexCLIStreamWorker,
        "for_process",
        classmethod(lambda cls, _pid: cls(transcript_path=tmp_path / "codex.jsonl")),
    )

    class _FakeProcess:
        id = "aaaaaaaa-1111-4111-9111-000000000001"
        typeid = None
        driver = CodexDriver()

        def __init__(self) -> None:
            self.workdir = str(tmp_path)
            self.cli_config = {}
            self.session_id = None
            self.project_id = None
            self.resolved_add_dirs = []
            self.status = ProcessStatus.STOPPED.value
            self.start_failure = None
            self.emitted: list[dict] = []

        def get_type(self) -> str:
            return "agentic_process"

        def get_agents_json(self) -> None:
            return None

        def _process_asset_context_kwargs(self, _assets) -> dict:
            return {}

        def make_turn_session_adopter(self, _log_prefix: str):
            # Mirrors AgenticProcess.make_turn_session_adopter's shape: a
            # coroutine function called per streamed frame with the worker's
            # session id. The spawn-failure turn never reports one.
            async def adopt(_sid: str | None) -> None:
                return None

            return adopt

        async def get_project(self) -> None:
            return None

        async def prepare_process_assets(self) -> object:
            return object()

        async def save(self) -> None:
            pass

        async def notify_updated(self) -> None:
            pass

        async def end_headless_turn(self, _log_prefix: str) -> None:
            object.__setattr__(self, "_turn_in_flight", False)
            await self.notify_updated()

        async def emit_flow_data(self, fd: dict) -> None:
            self.emitted.append(fd)

    proc = _FakeProcess()
    resp = await CodexDriver().headless_prompt(proc, "hi")  # type: ignore[arg-type]
    assert resp.status.lower() == "success"

    # The turn runs as a named background task — await it deterministically.
    task = next(t for t in asyncio.all_tasks() if t.get_name() == f"codex-{proc.id[:8]}")
    await task

    assert proc.status == ProcessStatus.FAILED.value
    assert proc.start_failure is not None and "not found on worker PATH" in proc.start_failure
    assert any("not found on worker PATH" in str(fd.get("flow_value", "")) for fd in proc.emitted)


@pytest.mark.asyncio
async def test_nonzero_exit_yields_status_and_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(monkeypatch, CodexCLIStreamWorker, ["bash", "-c", "printf 'boom\\n' >&2; exit 3"], stdin="")

    out = await _collect(worker, AgenticContext(workdir=str(tmp_path)))

    assert any(fd.attributes.get("subtype") == "exit-error" for fd in out)
    assert out[-1].attributes["element-type"] == FlowElementType.END


@pytest.mark.asyncio
async def test_cancel_reports_abort_not_exit_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A user-requested cancel (SIGINT-first close_session) classifies the
    non-zero exit as the canonical turn-abort STATUS, never ``exit-error``."""
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(monkeypatch, CodexCLIStreamWorker, ["bash", "-c", "sleep 60"], stdin="")
    ctx = AgenticContext(workdir=str(tmp_path))

    out: list = []

    async def _run():
        async for fd in worker.execute(prompt="hi", context=ctx):
            out.append(fd)

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.2)
    await worker.close_session()
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert worker._proc is not None and worker._proc.returncode not in (0, None)
    subtypes = [fd.attributes.get("subtype") for fd in out]
    assert "turn_aborted" in subtypes
    assert "exit-error" not in subtypes
    assert any(fd.attributes.get("turn-terminated") == "true" for fd in out)


@pytest.mark.asyncio
async def test_close_session_terminates_running_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    worker = CodexCLIStreamWorker(transcript_path=tmp_path / "codex.jsonl")
    patch_build_spawn(monkeypatch, CodexCLIStreamWorker, ["bash", "-c", "sleep 60"], stdin="")
    ctx = AgenticContext(workdir=str(tmp_path))

    async def _run():
        async for _fd in worker.execute(prompt="hi", context=ctx):
            pass

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.2)
    await worker.close_session()
    # The subprocess is terminated → stdout closes → the stream drains cleanly
    # and yields its terminal END frame within the cancel grace.
    await asyncio.wait_for(task, timeout=CANCEL_GRACE_SECONDS + 2)

    assert worker._proc is not None and worker._proc.returncode is not None

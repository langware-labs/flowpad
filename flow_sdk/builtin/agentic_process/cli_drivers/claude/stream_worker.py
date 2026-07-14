"""ClaudeCLIStreamWorker — print-mode Claude Code with per-event streaming.

Spawns ``claude -p --output-format stream-json --verbose`` as a subprocess,
reads stdout line-by-line, parses each line once, and converts the event
into FlowData via ``claude_event_to_flowdata.convert_event``, yielding it to
the caller.

Contrast with ``claude_cli_worker.ClaudeCLIWorker`` (sibling) which uses
``proc.communicate()`` — fully buffered, emits one CHAT block at the end.
This worker is the one used by the ``AgenticProcess.prompt`` action for
chat surfaces that need live FlowData.

Session continuity:
- If ``context.resume_session_id`` is set, passes ``--resume <sid>``. Claude
  continues the existing JSONL.
- Otherwise lets Claude generate a fresh session id. The first ``system:init``
  event on the stream carries it; we capture it onto ``self._session_id`` so
  callers can persist it on the AgenticProcess for the next turn.

Prompt delivery / cancel semantics:
- The prompt is delivered as a ``stream-json`` user message on the child's
  stdin (``--input-format stream-json``), NOT as an argv positional. Keeping
  stdin open unlocks the CLI's own cancellation protocol: ``close_session()``
  first writes a ``control_request/interrupt`` frame — the CLI aborts the turn
  itself, records the interrupted tool calls in its session JSONL (so the
  session stays coherent and resumable) and emits a proper ``result`` event.
  Only if the CLI doesn't wind down within the existing ``CANCEL_GRACE_SECONDS``
  does the legacy SIGTERM → grace → SIGKILL escalation run.
- In streaming-input mode the CLI stays alive after the turn waiting for more
  stdin; ``execute()`` closes stdin as soon as the terminal ``result`` event
  arrives so the process exits and the stream reaches EOF.
- A user-requested cancel is NOT an error: after ``close_session()``, the
  interrupted turn's ``result`` (which the CLI reports as ``is_error``) is
  reclassified to ``outcome=aborted`` and the worker emits the canonical
  turn-abort STATUS frame (``subtype=turn_aborted``, ``turn-terminated=true``)
  instead of ``exit-error``. Genuine crashes still surface ``exit-error``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import AsyncIterator

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.event_to_flowdata import (
    convert_event,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    STREAM_JSON_LINE_LIMIT_BYTES,
    AgenticContext,
    AgenticWorker,
    WorkerSpawnError,
    build_worker_spawn_env,
    resolve_worker_argv0,
    stamp_cli_run_id,
    terminate_asyncio_process_tree,
    wait_for_asyncio_process_or_kill_tree,
)
from flow_sdk.builtin.agentic_process.turn_abort import (
    TURN_TERMINATED_ATTR,
    abort_status_frame,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)

# Grace period before escalating SIGTERM → SIGKILL. Keep under the UI's cancel
# timeout (~10 s) so a stuck subprocess never wedges the chat.
CANCEL_GRACE_SECONDS = 5.0


class _TranscriptDurabilityGate:
    """Hold terminal Claude frames until the subprocess has settled.

    Claude Code 2.1.207 writes an ``assistant`` stream-json event to stdout
    before appending the matching assistant row to its session JSONL. Exposing
    that frame immediately lets a caller receive the reply and synchronously
    read a stale ``transcript/full`` snapshot.

    Claude Code 2.1.207 reports ``stop_reason=null`` even on its final text
    event. Its stable discriminator is the message content: intermediate tool
    events contain a ``tool_use`` block, while the terminal answer produces a
    CHAT frame without one. Explicit ``tool_use`` / ``pause_turn`` reasons are
    intermediate too; all other CHAT-producing assistant events are terminal
    CANDIDATES, including ``end_turn``, ``max_tokens``, error/refusal stops,
    and the real null-stop shape.

    Streaming-input mode (``--input-format stream-json``) splits one assistant
    message into PER-BLOCK events, so a tool call's narration text arrives as
    its own text-only assistant event — shape-identical to the final answer.
    A candidate is therefore held only until the stream proves the turn is
    continuing: a following ``assistant`` or ``user`` (tool_result) event
    means the held block was narration and the whole held run is released
    live, in order. Passive events (``rate_limit_event``-style statuses) join
    the hold — they may legitimately trail the real final answer. Once the
    ``result`` event arrives the hold is locked: the complete remaining
    suffix is retained through EOF so delayed status/result frames cannot
    move ahead of the answer, and is released only after the worker's
    existing subprocess-settlement path completes. No new clock, sleep,
    timeout, or polling budget is involved.
    """

    def __init__(self) -> None:
        self._pending_terminal: list[FlowData] = []
        self._result_seen = False

    def feed(self, event: dict | None, frames: list[FlowData]) -> list[FlowData]:
        event_type = str(event.get("type") or "") if event else ""
        if self._result_seen:
            self._pending_terminal.extend(frames)
            return []
        if event_type == "result":
            self._result_seen = True
            self._pending_terminal.extend(frames)
            return []

        message = event.get("message") if event and isinstance(event.get("message"), dict) else {}
        stop_reason = message.get("stop_reason")
        content = message.get("content")
        has_tool_use = isinstance(content, list) and any(
            isinstance(block, dict) and block.get("type") == "tool_use"
            for block in content
        )
        has_chat = any(
            frame.attributes.get("element-type") == FlowElementType.CHAT
            for frame in frames
        )
        terminal_assistant = (
            event_type == "assistant"
            and has_chat
            and not has_tool_use
            and stop_reason not in {"tool_use", "pause_turn"}
        )

        if self._pending_terminal:
            if event_type in {"assistant", "user"}:
                # The turn is provably continuing — the held candidate was
                # per-block narration, not the final answer. Release the held
                # run live, in order.
                released = self._pending_terminal
                self._pending_terminal = []
                if terminal_assistant:
                    self._pending_terminal = list(frames)
                    return released
                return [*released, *frames]
            self._pending_terminal.extend(frames)
            return []

        if terminal_assistant:
            self._pending_terminal.extend(frames)
            return []
        return frames

    def drain(self) -> list[FlowData]:
        pending, self._pending_terminal = self._pending_terminal, []
        self._result_seen = False
        return pending


def _stream_event(decoded: str) -> dict | None:
    try:
        event = json.loads(decoded)
    except (json.JSONDecodeError, TypeError):
        return None
    return event if isinstance(event, dict) else None


class ClaudeCLIStreamWorker(AgenticWorker):
    """Streaming Claude CLI worker using ``--output-format stream-json``.

    The class is intentionally stateless beyond ``_session_id`` and ``_proc``
    so callers can reuse a single instance across turns if they want, but the
    default usage is one-instance-per-turn (spawned by ``AgenticProcess.prompt``).
    """

    def __init__(self) -> None:
        self._session_id: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._process_run_id: str | None = None
        self._cancel_requested = False
        self._cancelled_gracefully = False
        self._stdin_open = False

    @property
    def cancelled_gracefully(self) -> bool:
        """True when the CLI honoured the interrupt control request itself.

        The cancel choke point (``_http_cancel_prompt``) skips the flowpad
        abort sidecar marker in that case — the CLI already recorded the
        interrupted tool calls in its own session JSONL, so a replay marker
        would duplicate the abort.
        """
        return self._cancelled_gracefully

    # ── AgenticWorker contract ────────────────────────────────────────────────

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        self._process_run_id = None
        try:
            # stdin_payload is always a string in production (the stream-json
            # user message); test fakes may pass None to run stdin-less.
            argv, env, stdin_payload = self._build_spawn(prompt, context)
        except WorkerSpawnError as e:
            # Surface the message on the chat stream, then propagate so the
            # turn runner latches status=FAILED + start_failure.
            yield _error(str(e))
            raise

        logger.info("ClaudeCLIStreamWorker: launching %s", " ".join(argv))
        self._process_run_id = stamp_cli_run_id(env)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=context.workdir,
                env=env,
                stdin=asyncio.subprocess.PIPE if stdin_payload is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=STREAM_JSON_LINE_LIMIT_BYTES,
            )
        except Exception as e:
            logger.exception("ClaudeCLIStreamWorker: spawn failed")
            message = f"spawn failed: {e}"
            yield _error(message)
            raise WorkerSpawnError("claude", message) from e

        # Deliver the prompt over stdin and KEEP the pipe open — it's the
        # channel ``close_session()`` uses for the graceful interrupt.
        if stdin_payload is not None:
            try:
                assert self._proc.stdin is not None
                self._proc.stdin.write(stdin_payload.encode("utf-8"))
                await self._proc.stdin.drain()
                self._stdin_open = True
            except Exception as e:
                logger.warning("ClaudeCLIStreamWorker: stdin prompt write failed: %s", e)

        # Drain stderr in the background so the OS pipe buffer never fills.
        stderr_task = asyncio.create_task(self._drain_stderr(self._proc))
        durability_gate = _TranscriptDurabilityGate()
        cancelled = False

        try:
            assert self._proc.stdout is not None
            async for line in self._proc.stdout:
                # ``line`` is bytes including the trailing newline. Parse the
                # JSON once per line and reuse the event dict for conversion,
                # session-id capture, and the durability gate — a line can be
                # up to 4 MB, so a re-parse per concern is not free.
                decoded = line.decode("utf-8", errors="replace")
                event = _stream_event(decoded)
                frames = convert_event(event) if event is not None else []
                for fd in frames:
                    # Capture session_id from the first ``system:init`` event.
                    if self._session_id is None and fd.attributes.get("subtype") == "init":
                        sid = event.get("session_id") if event else None
                        if isinstance(sid, str) and sid:
                            self._session_id = sid
                # Streaming-input mode: the CLI idles for more stdin after the
                # turn's terminal ``result``. Close stdin so it exits and the
                # stream reaches EOF (a killed/graceful-interrupted turn ends
                # via process exit instead).
                if event is not None and event.get("type") == "result":
                    self._close_stdin()
                for fd in durability_gate.feed(event, frames):
                    yield fd
        except asyncio.CancelledError:
            # Caller cancelled the async iteration — propagate after cleanup.
            cancelled = True
            await self._terminate_process()
            raise
        finally:
            # Always wait for the subprocess to settle so we don't leak zombies.
            if self._proc:
                await wait_for_asyncio_process_or_kill_tree(
                    self._proc,
                    CANCEL_GRACE_SECONDS,
                    run_id=self._process_run_id,
                )

            stderr_task.cancel()
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass

            # The process has settled, so its provider transcript cannot trail
            # stdout any further. Release the terminal answer + result/end in
            # their original order. A cancelled consumer receives no late data.
            if not cancelled:
                for fd in durability_gate.drain():
                    # A user-requested cancel is not an error: the CLI reports
                    # the interrupted turn's result as ``is_error``; reclassify
                    # so the chat renders an abort, not a crash.
                    yield self._reclassify_cancelled(fd)

            # If Claude exited cleanly without emitting a ``result`` event (which
            # would have produced ``<flow-end>`` via the converter), emit our own
            # terminator so downstream parsers always see a close.
            # The converter emits END after RESULT; if Claude crashed or was
            # killed before RESULT, we still owe the consumer an END frame.
            if not cancelled and self._cancel_requested:
                # Canonical turn-abort STATUS: marks in-flight tool calls
                # terminated in the chat grouping (same shape as the durable
                # sidecar marker replay).
                yield abort_status_frame()
            elif self._proc and self._proc.returncode != 0:
                yield _status(
                    "exit-error",
                    f"claude exited with code {self._proc.returncode}",
                )
            yield final_end_frame()

    async def close_session(self) -> None:
        """Stop the in-flight turn — graceful interrupt first, kill as backstop.

        Writes the Claude Code ``control_request/interrupt`` frame on the open
        stdin pipe; the CLI aborts the turn itself (recording the interrupted
        tool calls in its session JSONL) and emits a ``result`` — which makes
        ``execute()`` close stdin, so the process exits and ``proc.wait()``
        returns. Escalates to the legacy SIGTERM → grace → SIGKILL only when
        the CLI doesn't wind down within the existing ``CANCEL_GRACE_SECONDS``
        (the same budget the kill path already used — no new/raised timeout).
        """
        self._cancel_requested = True
        proc = self._proc
        if proc is not None and proc.returncode is None and self._stdin_open:
            control = {
                "type": "control_request",
                "request_id": f"flowpad-interrupt-{self._process_run_id or id(self)}",
                "request": {"subtype": "interrupt"},
            }
            try:
                assert proc.stdin is not None
                proc.stdin.write((json.dumps(control) + "\n").encode("utf-8"))
                await proc.stdin.drain()
            except Exception:
                logger.warning("claude interrupt control_request write failed; escalating to kill", exc_info=True)
            else:
                try:
                    await asyncio.wait_for(proc.wait(), CANCEL_GRACE_SECONDS)
                except asyncio.TimeoutError:
                    logger.warning("claude ignored interrupt control_request; escalating to kill")
                else:
                    self._cancelled_gracefully = True
                    return
        await self._terminate_process()

    def get_session_id(self) -> str | None:
        return self._session_id

    def manages_history(self) -> bool:
        # Claude writes its own JSONL; session_history.load_session_history
        # rehydrates from it on demand.
        return True

    # ── Internals ─────────────────────────────────────────────────────────────

    def _build_spawn(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> tuple[list[str], dict[str, str], str]:
        """Build (argv, env, stdin payload) via ``ClaudeCliOptions``.

        The prompt rides stdin as a stream-json user message
        (``--input-format stream-json``) so the open pipe doubles as the
        graceful-interrupt channel for ``close_session()``.

        Raises :class:`WorkerSpawnError` when claude is not installed (no
        harness capability discovered) or its executable can't be resolved on
        the spawn PATH.
        """
        # Resume takes priority — when ``resume_session_id`` is set, attach
        # ``--resume <sid>``. Otherwise honour ``context.session_id`` (a
        # pre-allocated UUID the caller wants Claude to use) so transcript
        # discovery doesn't race the first ``system:init`` event.
        #
        # Fork (``--resume <source> --fork-session --session-id <new>``):
        # ``ClaudeCliOptions`` wants ``session_id=<new>`` and
        # ``fork_session_id=<source>``. Mapping from ``AgenticContext`` puts
        # the source on ``resume_session_id`` and the new id on ``session_id``.
        resume_sid = context.resume_session_id
        fresh_sid = context.session_id if not resume_sid else None
        is_fork = bool(context.fork_session and resume_sid and context.session_id)
        if is_fork:
            opts_session_id = context.session_id  # new id
            opts_fork_source = resume_sid  # source id
        else:
            opts_session_id = resume_sid or fresh_sid
            opts_fork_source = None
        # NOTE: this is deliberately NOT ``driver.cli_options(process)``. The
        # headless per-turn spawn is an intentionally different shape from the
        # general/PTY options ``cmd_line`` reports: it forces the sonnet parent
        # (opus's parent latency blows the long-test budget), ``--print``/
        # stream-json transport, and relies on process instruction assets for
        # embedded-agent/persona content. Codex's equivalent forces
        # ``ephemeral=False`` so resume works. Do not "unify" these two
        # construction points — you'd regress model latency and resume behavior.
        opts = ClaudeCliOptions(
            workdir=context.workdir,
            env_vars=dict(context.env_vars) if context.env_vars else None,
            model=context.model,
            permission_mode=context.permission_mode,
            session_id=opts_session_id,
            resume=bool(resume_sid),
            fork_session_id=opts_fork_source,
            output_format="stream-json",
            print_mode=True,
            effort=context.effort,
            add_dirs=list(context.add_dirs),
            # verbose=True is auto-enabled by ClaudeCliOptions when
            # output_format == "stream-json".
        )
        opts.system_prompt_file = context.system_prompt_file
        # No argv instruction — the prompt is delivered over stdin (below) so
        # the pipe stays open as the graceful-interrupt channel.
        argv = opts.cli_cmd(instruction=None, system_prompt_append=context.instructions)
        argv.extend(["--input-format", "stream-json"])
        stdin_payload = (
            json.dumps(
                {
                    "type": "user",
                    "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
                }
            )
            + "\n"
        )
        env_from_opts = dict(opts.env_vars)

        # Start from os.environ so the CLI can find its creds, home. Strip
        # CLAUDECODE* to avoid the CLI thinking it's already inside a Claude
        # run. Context env_vars win (except the discovered capability bin
        # folder stays first on PATH); argv[0] is pinned to the discovered
        # absolute executable so a stripped backend service PATH can't break
        # the spawn.
        base_env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
        env = build_worker_spawn_env("claude", env_from_opts, base_env=base_env)
        argv = resolve_worker_argv0("claude", argv, env)
        return argv, env, stdin_payload

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        """Read and log stderr so the pipe buffer never fills.

        stderr is verbose in ``--debug`` mode; in the default path it's mostly
        empty. We log at DEBUG level so it's visible during investigation but
        doesn't clutter normal runs.
        """
        if proc.stderr is None:
            return
        try:
            async for line in proc.stderr:
                decoded = line.decode("utf-8", errors="replace").rstrip()
                if decoded:
                    logger.warning("claude stderr: %s", decoded)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.warning("stderr drain error", exc_info=True)

    async def _terminate_process(self) -> None:
        """SIGTERM → grace → SIGKILL. Safe to call multiple times."""
        proc = self._proc
        if proc is None:
            return
        await terminate_asyncio_process_tree(
            proc,
            CANCEL_GRACE_SECONDS,
            run_id=self._process_run_id,
        )

    def _close_stdin(self) -> None:
        """Close the child's stdin pipe (idempotent)."""
        if not self._stdin_open:
            return
        self._stdin_open = False
        proc = self._proc
        if proc is None or proc.stdin is None:
            return
        try:
            proc.stdin.close()
        except Exception:
            logger.debug("claude stdin close failed", exc_info=True)

    def _reclassify_cancelled(self, fd: FlowData) -> FlowData:
        """Downgrade an interrupted turn's error RESULT to ``outcome=aborted``.

        The CLI reports a ``control_request/interrupt``-ed turn as
        ``subtype=error_during_execution, is_error=true``; without this, the
        chat would paint a user-initiated stop as a crash.
        """
        if (
            self._cancel_requested
            and fd.attributes.get("element-type") == FlowElementType.RESULT
            and fd.attributes.get("outcome") == "error"
        ):
            fd.attributes["outcome"] = "aborted"
            fd.attributes[TURN_TERMINATED_ATTR] = "true"
        return fd


# ── Module helpers ────────────────────────────────────────────────────────────


def _error(message: str) -> FlowData:
    return FlowData(
        flow_value=message,
        attributes={
            "element-type": FlowElementType.ERROR,
            "data-type": FlowDataType.TEXT,
        },
    )


def _status(subtype: str, value: str = "") -> FlowData:
    return FlowData(
        flow_value=value,
        attributes={
            "element-type": FlowElementType.STATUS,
            "data-type": FlowDataType.TEXT,
            "subtype": subtype,
        },
    )



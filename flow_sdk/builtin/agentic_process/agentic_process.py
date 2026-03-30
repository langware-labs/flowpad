"""AgenticProcess entity — represents a single execution run of Claude."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable
from uuid import uuid4

from pydantic import SerializationInfo, model_serializer

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.app.actions.listen import set_plan_auto_approve
from flow_sdk.builtin.cli_workers import ClaudeCliOptions
from flow_sdk.core import Entity, action
from flow_sdk.core.entity.entity_model import EntityExpansion
from flow_sdk.fs_records.agentic_process_record import AgenticProcessStatus
from flow_sdk.fs_records.agent_status import is_idle as _is_idle_status
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

from flow_sdk.builtin.agentic_process._shared import (
    _default_processor_state,
    _now_iso,
    _send_flow_data_message,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.shell import Shell

logger = logging.getLogger(__name__)

class AgenticProcess(Entity):
    _api_visible = True
    type: str = APIField(default="agentic_process")

    processor_id: str | None = APIField(default=None)
    instruction_content: str | None = APIField(default=None)
    source_vfs_path: str | None = APIField(default=None)
    context: dict[str, Any] = APIField(default_factory=dict)
    context_data: dict[str, Any] = APIField(default_factory=dict)
    cli_config: dict[str, Any] = APIField(default_factory=dict)
    workdir: str | None = APIField(default=None)
    favorite_index: int | None = APIField(default=None)
    state: dict[str, Any] = APIField(default_factory=_default_processor_state)
    worker_session_id: str | None = APIField(default=None)
    use_worker_history: bool = APIField(default=False)
    project_id: str | None = APIField(default=None)
    project_encoded_name: str | None = APIField(default=None)
    compute_node_id: str | None = APIField(default=None)
    shell_id: str | None = APIField(default=None)
    sidecar_shell_id: str | None = APIField(default=None)
    visible: bool = APIField(default=False, description="Whether this process is visible in the tabs view")
    is_active: bool = APIField(default=False)
    queue: dict | None = APIField(default=None)
    additional_dirs: list[str] = APIField(default_factory=list, description="Extra directories passed to Claude via --add-dir")

    @property
    def cli_options(self) -> "ClaudeCliOptions":
        """Deserialize cli_config into a live ClaudeCliOptions.

        session_id and workdir are injected from entity fields (not stored in cli_config).
        Bundled system_assets dir is always prepended; additional_dirs follow.
        Callers add runtime env vars via add_env() before calling to_shell_string().
        """
        import flow_sdk
        from flow_sdk.builtin.cli_workers import ClaudeCliOptions
        cmd = ClaudeCliOptions.from_json(self.cli_config)
        cmd.session_id = self.worker_session_id
        cmd.workdir = self.workdir
        if cmd.workdir:
            cmd.env_vars.setdefault("CLAUDE_PROJECT_DIR", cmd.workdir)
        core_dir = str(Path(flow_sdk.__file__).parent / "system_assets" / "core")
        extra = [d for d in (self.additional_dirs or []) if d != core_dir]
        cmd.add_dirs = [core_dir] + extra
        return cmd


    @action.post(action_name="add-dir")
    async def add_dir(self, path: str) -> "ApiResponse":
        """Append a directory to additional_dirs (passed to Claude via --add-dir)."""
        from flow_sdk.responses.response import ApiSuccessResponse
        if path not in (self.additional_dirs or []):
            self.additional_dirs = list(self.additional_dirs or []) + [path]
            await self.save()
        return ApiSuccessResponse()

    def _is_exist_claude_resume_session(self, claude_session_id: str | None) -> bool:
        """Check if there's a resumable Claude session for this agentic process."""
        return self._discover_claude_record_session(claude_session_id) is not None


    def _discover_claude_record_session(self, claude_session_id: str | None) -> ClaudeSessionRecord | None:
        """Discover the ClaudeSessionRecord associated with this agentic process's worker_session_id."""
        if not claude_session_id:
            return None

        return ClaudeSessionRecord.discover_one(claude_session_id)


    async def get_project(self) -> None:
        """Resolve project_id, workdir, and project_encoded_name from DB ancestry.

        Mutates self in place. No-op for fields already set.
        """
        from flow_sdk.builtin.project import Project

        if not self.project_id:
            if self.context_data.get("project_id"):
                self.project_id = self.context_data["project_id"]
            else:
                ancestor = await Project.get_ancestor(self.typeid)
                if ancestor:
                    self.project_id = ancestor.id

        if self.project_id and (not self.workdir or not self.project_encoded_name):
            project = await Project.get_by_id(self.project_id)
            if project and project.fs_storage_mount_path:
                if not self.workdir:
                    self.workdir = str(project.fs_storage_mount_path)
                if not self.project_encoded_name:
                    self.project_encoded_name = project.project_encoded_name

    def _discover_status_from_transcript(self) -> AgenticProcessStatus | None:
        """Derive status from the Claude session transcript record.

        Delegates to ``ClaudeSessionRecord.status`` which tracks the
        last assistant ``stop_reason`` during JSONL parsing.
        Returns the status string, or None if no transcript is available.
        """

        session = self._discover_claude_record_session(self.worker_session_id)
        return session.status if session else None

    @property
    def is_idle(self) -> bool:
        """True when no Claude session is active or the session has reached a terminal state.

        Returns False while a subprocess has been launched but no transcript is written yet,
        so callers can safely call ``waitForIdle()`` immediately after ``prompt()``.
        """
        if not self.worker_session_id:
            return True
        status = self._discover_status_from_transcript()
        if status is None:
            return False  # session linked but transcript file not found yet
        try:
            status = AgenticProcessStatus(status)
        except ValueError:
            return False
        if status in (AgenticProcessStatus.NULL, AgenticProcessStatus.EMPTY):
            return False  # transcript not yet written → subprocess still launching
        return _is_idle_status(status)

    async def waitForIdle(self, timeout: float | None = None) -> None:
        """Poll until ``is_idle`` is True.

        Raises ``TimeoutError`` if *timeout* seconds elapse before idle.
        """
        deadline = (asyncio.get_event_loop().time() + timeout) if timeout else None
        while True:
            if self.is_idle:
                return
            if deadline and asyncio.get_event_loop().time() > deadline:
                raise TimeoutError(f"Process did not become idle within {timeout}s")
            await asyncio.sleep(2.0)

    @property
    def effective_status(self) -> AgenticProcessStatus:
        """Current status: transcript-derived when available, otherwise from persisted state."""
        transcript = self._discover_status_from_transcript()
        if transcript is not None:
            return AgenticProcessStatus(transcript)
        state_status = self._get_process_state().get("status")
        if state_status:
            try:
                return AgenticProcessStatus(state_status)
            except ValueError:
                pass
        return AgenticProcessStatus.NEW

    def _get_process_state(self) -> dict[str, Any]:
        if not isinstance(self.state, dict):
            self.state = _default_processor_state()
        state = dict(self.state)

        # Derive status from transcript if available
        transcript_status = self._discover_status_from_transcript()
        if transcript_status is not None:
            state["status"] = transcript_status

        return state

    def _set_process_state(self, **updates: Any) -> None:
        if not isinstance(self.state, dict):
            self.state = _default_processor_state()
        state = dict(self.state)
        state.update(updates)
        self.state = state

    @model_serializer(mode="wrap")
    def api_json_serializer(self, nxt, info: SerializationInfo):
        if info.context and info.context.get("skip_api_serializer"):
            return nxt(self)
        data = nxt(self)
        if data is None:
            return None
        if data.get("expand") is None or (isinstance(data.get("expand"), dict) and not data["expand"]):
            data["expand"] = EntityExpansion()
        data = {key: value for key, value in data.items() if value is not None and self.is_api_field(key)}
        return data

    @action.all(action_name="control")
    async def control(self):
        """Unified control action dispatched by sub_path.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Routes to internal control methods based on sub_path:
        - /control/pause - Pause message processing
        - /control/resume - Resume message processing
        - /control/inject - Inject a new message

        Returns:
            ApiResponse with status or error message
        """
        request_info = get_current_request_info()
        if request_info is None:
            return ApiFailResponse(message="No request context available")

        sub_action = request_info.sub_path
        if not sub_action:
            return ApiFailResponse(message="Missing sub_path for control action")

        # Remove leading slash if present
        sub_action = sub_action.lstrip("/")

        if sub_action == "pause":
            return await self._control_pause()
        elif sub_action == "resume":
            return await self._control_resume()
        elif sub_action == "inject":
            return await self._control_inject(request_info)
        else:
            return ApiFailResponse(message=f"Unknown control action: {sub_action}")

    async def _control_pause(self):
        """Pause message processing."""
        logger.info(f"AgenticProcess {self.id}: control/pause")
        self._set_process_state(status=AgenticProcessStatus.PAUSED.value)
        await self.save()
        return ApiSuccessResponse(data={"status": AgenticProcessStatus.PAUSED.value})

    async def _control_resume(self):
        """Resume message processing after pause."""
        logger.info(f"AgenticProcess {self.id}: control/resume")
        self._set_process_state(status=AgenticProcessStatus.RUNNING.value)
        await self.save()
        return ApiSuccessResponse(data={"status": AgenticProcessStatus.RUNNING.value})

    async def _control_inject(self, request_info):
        """Inject a new message into the worker's input queue."""
        # Get message from request parameters or POST body
        message = None
        if request_info.request_parameters:
            message = request_info.request_parameters.get("message")
        if not message:
            post_data = await request_info.get_post_data()
            if isinstance(post_data, dict):
                message = post_data.get("message")

        if not message:
            return ApiFailResponse(message="Missing 'message' parameter")

        logger.info(f"AgenticProcess {self.id}: control/inject message: {message[:80]}...")

        # Desktop stub: no active worker, log and return success
        return ApiSuccessResponse(data={"injected": True, "message_length": len(message)})

    @action.get(action_name="input-dir")
    async def get_input_dir(self):
        """Return the absolute path of this process's input directory, creating it if needed."""
        from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
        from flow_sdk.fs_store.record import get_default_records_root, record_stem

        record = None
        try:
            record = AgenticProcessRecord.discover_one(self.id)
        except Exception:
            pass

        if record and record.record_dir:
            input_dir = record.input_dir
        else:
            uid = self.id
            root = get_default_records_root()
            record_dir = root / AgenticProcessRecord._record_type / record_stem(AgenticProcessRecord._record_type, uid)
            input_dir = record_dir / "input"
            input_dir.mkdir(parents=True, exist_ok=True)

        compute_node_id = self.compute_node_id or "compute_node-@local"

        return ApiSuccessResponse(
            data={
                "abs_path": str(input_dir),
                "compute_node_id": compute_node_id,
            }
        )

    @action.all(action_name="queue")
    async def queue_action(self, enabled: bool | None = None, entries: list | None = None):
        """GET returns the prompt queue; POST updates it."""
        from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
        from flow_sdk.fs_store.record import get_default_records_root, record_stem

        request_info = get_current_request_info()
        method = (request_info.method if request_info else "get").lower()

        record = None
        try:
            record = AgenticProcessRecord.discover_one(self.id)
        except Exception:
            pass

        # Resolve record_data_dir: prefer discovered record, fall back to computed path
        if record and record.record_dir:
            record_data_dir = record.record_dir
        else:
            uid = self.id
            root = get_default_records_root()
            record_data_dir = root / AgenticProcessRecord._record_type / record_stem(AgenticProcessRecord._record_type, uid)

        if method == "get":
            queue_path = record_data_dir / "queue.json"
            if queue_path.exists():
                try:
                    return ApiSuccessResponse(data=json.loads(queue_path.read_text()))
                except Exception:
                    pass
            return ApiSuccessResponse(data={"enabled": True, "entries": []})

        # POST: update queue.json
        record_data_dir.mkdir(parents=True, exist_ok=True)
        queue_path = record_data_dir / "queue.json"
        current = json.loads(queue_path.read_text()) if queue_path.exists() else {"enabled": True, "entries": []}
        if enabled is not None:
            current["enabled"] = enabled
        if entries is not None:
            current["entries"] = entries
        queue_path.write_text(json.dumps(current, indent=2))
        return ApiSuccessResponse(data=current)

    @action.get(action_name="get-history")
    async def get_history(self):
        """Get the execution history for this process.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Desktop stub: returns empty history (no worker/blob storage in desktop mode).

        Returns:
            ApiSuccessResponse with list of FlowData items
        """
        return ApiSuccessResponse(
            data={
                "history": [],
                "count": 0,
                "worker_session_id": self.worker_session_id,
                "use_worker_history": self.use_worker_history,
            }
        )

    @action.all(action_name="step")
    async def step_action(self):
        """Execute one instruction step.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Desktop stub: validates status and returns step result.

        Returns:
            ApiSuccessResponse with step result
        """
        state = self._get_process_state()

        if state.get("status") == AgenticProcessStatus.INTERRUPTED.value:
            return ApiFailResponse(message="Process has been terminated")

        if state.get("status") == AgenticProcessStatus.RUNNING.value:
            return ApiFailResponse(message="Process is already running")

        logger.info(f"AgenticProcess {self.id}: step action")

        try:
            # Desktop mode: set status back to idle (no real instruction execution)
            self._set_process_state(status=AgenticProcessStatus.IDLE.value)
            await self.save()

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": self._get_process_state().get("status"),
                    "index": self.state.get("index", 0) if isinstance(self.state, dict) else 0,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} step error: {e}")
            self._set_process_state(status=AgenticProcessStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    async def close(self) -> bool:
        """Terminate this process and close its linked shell.

        Returns True on success, False if already terminated or on error.
        """
        if self._get_process_state().get("status") == AgenticProcessStatus.INTERRUPTED.value:
            logger.debug("[AgenticProcess] close() skipped for %s: already terminated", self.id)
            return False

        logger.info(f"AgenticProcess {self.id}: close")

        try:
            shell_id = self.shell_id
            if shell_id:
                self.shell_id = None
                self.sidecar_shell_id = None

            self._set_process_state(status=AgenticProcessStatus.INTERRUPTED.value)
            await self.save()

            if shell_id:
                from flow_sdk.builtin.shell import Shell
                shell = await Shell.get_by_id(shell_id)
                if shell:
                    await shell.close()

            return True

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} close error: {e}")
            return False

    @action.all(action_name="exit")
    async def exit_action(self):
        """Terminate this process.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Delegates to close(), then returns an ApiResponse for the HTTP layer.

        Returns:
            ApiSuccessResponse confirming termination
        """
        if not await self.close():
            return ApiFailResponse(message="Process already terminated or close failed")

        return ApiSuccessResponse(
            data={
                "id": self.id,
                "status": AgenticProcessStatus.INTERRUPTED.value,
                "terminated": True,
            }
        )

    # ============ PTY Lifecycle ============

    async def _find_resumable_session(self, session_id: str) -> str | None:
        """Walk up the fork chain to find a session ID with a transcript on disk.

        Claude CLI doesn't always create a .jsonl for forked sessions,
        so fork-of-fork needs to find the nearest ancestor that does.
        Returns the session ID with a transcript, or None if none found.
        """
        candidate: str | None = session_id
        seen: set[str] = set()
        while candidate and candidate not in seen:
            seen.add(candidate)
            if ClaudeSessionRecord.discover_one(candidate) is not None:
                return candidate
            procs = await AgenticProcess.get_all()
            parent = next((p for p in procs if p.worker_session_id == candidate), None)
            candidate = parent.context_data.get("resume_session_id") if parent else None
        return None

    async def _open_shell(
        self,
        reuse_id: str | None = None,
        name: str | None = None,
        workdir: str | None = None,
        compute_node: Any = None,
    ) -> Any:
        """Get existing shell by reuse_id, or create a new one."""
        from flow_sdk.builtin.shell import Shell

        if reuse_id:
            shell = await Shell.get_by_id(reuse_id)
            if shell:
                return shell

        # Restore tab_order saved by stop() so the restarted shell keeps its
        # position.  For brand-new shells, append after all existing ones.
        prev = self.context_data.pop("_prev_tab_order", None)
        tab_order = prev if prev is not None else await Shell.next_tab_order()

        shell = Shell(
            compute_node_id=compute_node.id if compute_node else None,
            name=name,
            workdir=workdir,
            tab_order=tab_order,
        )
        await shell.save()
        return shell

    def _make_pty_exit_callback(self) -> Callable[[int | None], None]:
        """Create a callback for PTY process exit that updates process state.

        Captures agentic_process_id and the running event loop. The callback is called
        from the daemon reader thread, so it schedules the async state update
        via run_coroutine_threadsafe.
        """
        main_loop = asyncio.get_running_loop()
        agentic_process_id = self.id

        def _on_pty_exit(exit_code: int | None) -> None:
            async def _update_state():
                try:
                    proc = await AgenticProcess.get_by_id(agentic_process_id)
                    if not proc:
                        return
                    # If shell_id is already cleared, stop() handled the
                    # transition. Don't overwrite with complete/error.
                    if not proc.shell_id:
                        logger.info(
                            "AgenticProcess %s: PTY exited (code=%s), skipping — already handled by stop",
                            agentic_process_id,
                            exit_code,
                        )
                        return
                    # Detach from the shell but do NOT delete it — the user
                    # may still see the tab and click X, which calls shell.close().
                    proc.shell_id = None
                    proc.sidecar_shell_id = None

                    if exit_code is not None and exit_code != 0:
                        proc._set_process_state(
                            error=f"claude exited with code {exit_code}",
                        )
                    else:
                        # Clean exit (code 0): transition back to idle
                        proc._set_process_state(status=AgenticProcessStatus.IDLE.value)
                    await proc.save()

                    logger.info(
                        "AgenticProcess %s: PTY exited (code=%s), state updated",
                        agentic_process_id,
                        exit_code,
                    )
                except Exception as exc:
                    logger.warning("AgenticProcess %s: on_exit update failed: %s", agentic_process_id, exc)

            asyncio.run_coroutine_threadsafe(_update_state(), main_loop)

        return _on_pty_exit

    @property
    def compute_node(self) -> "ComputeNode":
        """The local ComputeNode backing this process's PTY sessions.

        compute_node_id is stored as the full typeid string ``compute_node-<uuid>``.
        Raises ValueError if compute_node_id is not set — call open() which resolves it first.
        """
        if not self.compute_node_id:
            raise ValueError(
                f"AgenticProcess {self.id!r} has no compute_node_id. "
                "Call open() to resolve and assign the compute node."
            )
        from flow_sdk.builtin.faas.compute_node import ComputeNode
        parts = self.compute_node_id.split("-", 1)
        node_id = parts[1] if len(parts) == 2 else self.compute_node_id
        return ComputeNode(id=node_id, node_provider_id="local", node_provider_type="local_machine")

    async def _send_pty_raw(self, compute_node, data: bytes) -> None:
        """Send raw bytes into an already-running PTY session."""
        shell_id = self.shell_id
        if not shell_id:
            raise RuntimeError("PTY session has no shell_id")
        pty = compute_node.get_pty(shell_id)
        if pty is None:
            raise RuntimeError(f"PTY session not found for shell_id {shell_id}")
        await pty.send(data)

    async def _send_command_to_pty(self, compute_node, command: str) -> None:
        """Send a command into an already-running PTY session."""
        await self._send_pty_raw(compute_node, f"{command}\r".encode())

    @action.post(action_name="open")
    async def open(self, instruction: str | None = None, worker_session_id: str | None = None, visible: bool | None = None):
        """Open (or reopen) this AgenticProcess — starts fresh or resumes automatically.

        Covers all cases:
        - Fresh open (no previous session): spawns Claude with --session-id.
        - Reopen after server restart (stale shell, dead PTY): Shell.start_pty() detects
          the dead PTY, cleans up, and spawns Claude with --resume.
        - Idempotent call on live process: Shell.start_pty() detects alive PTY and returns
          ApiSuccessResponse without re-spawning.

        The frontend calls open() on every navigation to an agentic-process URL;
        the backend decides whether to start fresh, resume, or do nothing.
        """

        state = self._get_process_state()
        if state.get("status") == AgenticProcessStatus.INTERRUPTED.value:
            return ApiFailResponse(message="Process has been terminated")


        # Detect restart: process previously had a shell session.
        # Captured before _open_shell so it reflects the pre-call state.
        had_previous_session = bool(self.shell_id)

        # Resolve compute node: if not yet assigned, look up the @local node (desktop only).
        if not self.compute_node_id:
            from flow_sdk.builtin.faas.compute_node import ComputeNode
            local_node = await ComputeNode.get_one({"uname": "local"})
            if not local_node:
                return ApiFailResponse(
                    message="No compute node assigned and no @local compute node found. "
                    "This environment does not support local process execution."
                )
            self.compute_node_id = str(local_node.typeid)

        compute_node = self.compute_node

        try:
            self.worker_session_id = worker_session_id or self.worker_session_id or str(uuid4())
            self.compute_node_id = str(compute_node.typeid)

            await self.get_project()

            # Build the CLI command from cli_config + entity fields
            cmd = self.cli_options

            # Server-restart resume: process had a shell but cli_config didn't encode resume
            if not cmd.resume and self.shell_id:
                cmd.resume = self._is_exist_claude_resume_session(self.worker_session_id)

            # Fork: resolve chain to nearest ancestor with a transcript on disk
            if cmd.fork_session_id:
                cmd.fork_session_id = await self._find_resumable_session(cmd.fork_session_id)

            # When resuming, ensure CLAUDE_PROJECT_DIR points to where the session lives.
            # The stored workdir may be a parent directory; use session cwd to be precise.
            if cmd.resume and self.worker_session_id:
                session_rec = self._discover_claude_record_session(self.worker_session_id)
                if session_rec and session_rec.cwd:
                    cmd.env_vars["CLAUDE_PROJECT_DIR"] = session_rec.cwd
                    cmd.workdir = session_rec.cwd

            # Runtime env injection (process identity for hook routing)
            cmd.add_env(
                "FLOWPAD_EXECUTION_SCOPE",
                json.dumps([{"type": self.get_type(), "id": self.id}]),
            )

            is_resume = cmd.resume
            is_fork = bool(cmd.fork_session_id)

            workdir = self.workdir
            session_name = f"Claude - {self.worker_session_id[:8]} ({'fork' if is_fork else 'resume' if is_resume else 'new'})"
            shell = await self._open_shell(
                reuse_id=self.shell_id,   # reuse existing tab on restart; None for fresh open
                name=session_name,
                workdir=workdir,
                compute_node=compute_node,
            )
            self.shell_id = shell.id
            on_exit = self._make_pty_exit_callback()
            # Write process ID back to ShellRecord so the shell knows its owning process
            try:
                from flow_sdk.fs_records.shell_record import ShellRecord
                _shell_rec = ShellRecord.discover_one(shell.id)
                if _shell_rec:
                    object.__setattr__(_shell_rec, "agentic_process_id", self.id)
                    object.__getattribute__(_shell_rec, "_dirty_keys").add("agentic_process_id")
                    _shell_rec.save()
            except Exception as _e:
                logger.debug("AgenticProcess %s: failed to update ShellRecord.agentic_process_id: %s", self.id, _e)

            logger.info(
                "AgenticProcess %s: %s shell %s (worker=%s)",
                self.id,
                "reopening" if had_previous_session else "opening",
                self.shell_id,
                self.worker_session_id,
            )

            started = await shell.start_pty()

            # Also run_process when the PTY was already alive (start_pty returns False)
            # but the worker (Claude) is dead — i.e. server restart killed Claude but left zsh running.
            worker_is_dead = not started and not await shell.worker_alive()
            if started or worker_is_dead:
                if not started:
                    logger.info(
                        "AgenticProcess %s: PTY alive but worker dead — re-injecting process into existing shell",
                        self.id,
                    )
                else:
                    await asyncio.sleep(1.0)  # let shell initialize and write prompt before injecting
                execution_info = await shell.run_process(cmd, instruction=instruction)
                logger.info(
                    "AgenticProcess %s worker launched: pid=%s name=%r",
                    self.id, execution_info.pid, execution_info.name,
                )

            self._set_process_state(status=AgenticProcessStatus.RUNNING.value, error=None)
            if visible is not None:
                self.visible = visible
            await self.save()

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": AgenticProcessStatus.RUNNING.value,
                    "shell_id": self.shell_id,
                    "worker_session_id": self.worker_session_id,
                    "compute_node_id": self.compute_node_id,
                    "shell": shell.model_dump(mode="json"),
                    "is_resume": is_resume,
                    "worker_pid": shell.worker_pid,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} open error: {e}")
            self.shell_id = None
            self._set_process_state(status=AgenticProcessStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.post(action_name="stop")
    async def stop(self):
        """Stop the active shell session.

        Delegates all PTY teardown to Shell.close(). Preserves worker_session_id
        so the Claude conversation can be resumed later.

        Returns:
            ApiSuccessResponse confirming the stop.
        """
        if not self.shell_id:
            return ApiFailResponse(message="No active shell session")

        try:
            from flow_sdk.builtin.shell import Shell

            old_shell_id = self.shell_id

            # Preserve tab_order so open() can place the new shell in the same slot.
            shell = await Shell.get_by_id(old_shell_id)
            if shell:
                self.context_data = {**self.context_data, "_prev_tab_order": shell.tab_order}

            # Clear shell_id BEFORE closing so on_exit callback sees None and skips.
            self.shell_id = None
            self.sidecar_shell_id = None
            await self.save()

            if shell:
                await shell.close()
                logger.info("AgenticProcess %s: closed Shell entity %s", self.id, old_shell_id)
            else:
                logger.warning("AgenticProcess %s: Shell entity %s not found", self.id, old_shell_id)

            logger.info(
                "AgenticProcess %s: stopped (worker_session_id preserved: %s)",
                self.id,
                self.worker_session_id,
            )

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": AgenticProcessStatus.IDLE.value,
                    "shell_id": None,
                    "worker_session_id": self.worker_session_id,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} stop error: {e}")
            return ApiFailResponse(message=str(e))

    async def get_shell(self) -> "Shell | None":
        """Resolve shell_id to the linked Shell entity.

        Returns None if no shell is currently linked (process not open).
        Mirrors TS AgenticProcess.getShell().
        """
        if not self.shell_id:
            return None
        from flow_sdk.builtin.shell import Shell

        return await Shell.get_by_id(self.shell_id)

    async def send_input(self, text: str) -> None:
        """Write raw text to the live PTY stdin.

        Requires open() to have been called first.
        Mirrors TS AgenticProcess.sendInput().
        """
        shell = await self.get_shell()
        if not shell:
            raise ValueError("No shell linked — call open() first")
        await shell.send_input(text)

    async def sync_status(self) -> None:
        """Correct state.status from actual PTY liveness. Persists if changed.

        Eliminates ghost-running: if state says running but the linked shell's
        PTY is dead, status is corrected to idle and saved. Call this on WS
        reconnect (server restart recovery) or after shell.pty.destruct() in tests.

        Replaces the need for a derived resolved_status property — state.status
        is always the authoritative value after this call.
        """
        current = self._get_process_state().get("status")
        if current != AgenticProcessStatus.RUNNING.value:
            return
        shell = await self.get_shell()
        if shell is None or not shell.connected:
            self._set_process_state(status=AgenticProcessStatus.IDLE.value)
            await self.save()

    @action.post(action_name="execute-plan")
    async def execute_plan(
        self,
        file_path: str,
        clear_context: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """
        Tell Claude to execute the plan.
        If clear_context=True, inject '/clear' first.

        Sets the plan auto-approve flag so that when ExitPlanMode is called,
        the hook handler can auto-approve the PermissionRequest once.
        """
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            if clear_context:
                # Inject /clear command to reset context
                await self._control_inject_message("/clear")
                await asyncio.sleep(1)  # Wait for context to clear before sending the next command

            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>, if any, then execute plan"
            await self._control_inject_message(prompt)
            await asyncio.sleep(1.5)  # Wait for the command to be processed and the plan to be entered before setting auto-approve

            set_plan_auto_approve(self.id)

            return ApiSuccessResponse(data={"injected": True})
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} execute-plan error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="update-plan")
    async def update_plan(
        self,
        file_path: str,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """
        Tell Claude to update the plan based on <plan-note> annotations.
        Claude reads the file itself; <plan-note> tags are left unchanged.
        """
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>"
            await self._control_inject_message(prompt)

            return ApiSuccessResponse(data={"ok": True})
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} update-plan error: {e}")
            return ApiFailResponse(message=str(e))

    async def _control_inject_message(self, message: str) -> None:
        """Inject a message into the active PTY session for this process.

        Resolves the compute node, sends Escape to dismiss any active
        numeric prompt (e.g. Claude waiting for a numbered answer), then
        sends the message as PTY input.
        If no PTY session is active, logs a warning and returns silently.
        """
        if not self.shell_id:
            logger.warning("AgenticProcess %s: no active shell, cannot inject message", self.id)
            return

        compute_node = self.compute_node

        # Dismiss any active numeric prompt before injecting.
        # Terminal input parsers (Node.js libuv, readline, etc.) treat a lone
        # \x1b as the start of an escape sequence and wait ~100ms for more
        # bytes.  If our command arrives within that window the first byte is
        # swallowed as part of sequence parsing.  We therefore:
        #   1. Send a single \x1b — enough to trigger an Escape keypress.
        #   2. Sleep 200ms — longer than the escape-sequence timeout — so the
        #      handler commits "Escape pressed" and Claude transitions state
        #      before the command bytes arrive.
        await self._send_pty_raw(compute_node, b"\x1b")
        await asyncio.sleep(0.2)

        logger.info("AgenticProcess %s: injecting message: %s", self.id, message[:80])
        await self._send_command_to_pty(compute_node, message)

"""AgenticProcess entity — represents a single execution run of Claude."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable
from uuid import uuid4

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.app.actions.listen import set_plan_auto_approve
from flow_sdk.builtin.cli_workers import ClaudeCliOptions
from flow_sdk.core import Entity, action
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_records.agentic_process_record import AgenticProcessStatus
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.shell import Shell

logger = logging.getLogger(__name__)


async def _index_session_on_close(session_id: str, pty_title: str | None = None) -> None:
    """Index the ClaudeSessionRecord after an AgenticProcess closes (fire-and-forget).

    pty_title: Claude-generated tab title captured from ANSI OSC escapes in PTY
               output. Used as the FTS title / entity name when the JSONL has no
               user-set custom-title (i.e. the user never ran /rename).
    """
    try:
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
        record = ClaudeSessionRecord.discover_one(session_id)
        if record:
            if pty_title:
                inst = object.__getattribute__(record, "__dict__")
                if not inst.get("custom_title"):
                    record.name = pty_title
                    _ = record.search_content  # populate _fts_cache
                    cache = inst.get("_fts_cache")
                    object.__setattr__(
                        record, "_fts_cache",
                        (pty_title[:120], cache[1] if cache else None),
                    )
            await record.sync_to_db()
            logger.debug("[AgenticProcess] indexed session %s on close", session_id)
    except Exception:
        logger.debug("[AgenticProcess] failed to index session %s on close", session_id, exc_info=True)


async def _poll_for_completion(agentic_process_id: str, session_id: str | None) -> None:
    """Background task: poll the session transcript until COMPLETE/ERROR, then save.

    Called from AgenticProcess.start() after launching the worker. When Claude
    exits (end_turn / stop_sequence), the transcript tail changes. Saving the
    updated status broadcasts a WS entity-update that lets the TypeScript
    AgenticProcess._markComplete() fire and the output() generator terminate.
    """
    from flow_sdk.fs_records.agent_status import AgenticProcessStatus
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

    TERMINAL = {AgenticProcessStatus.COMPLETE, AgenticProcessStatus.ERROR, AgenticProcessStatus.INTERRUPTED}

    await asyncio.sleep(5)  # give Claude time to start and write the first JSONL entry
    for _ in range(360):  # poll up to 30 min (360 * 5 s)
        await asyncio.sleep(5)
        try:
            if not session_id:
                break
            record = ClaudeSessionRecord.discover_one(session_id)
            if record is None:
                continue  # transcript not written yet

            new_status = record.status
            try:
                status_enum = AgenticProcessStatus(str(new_status))
            except ValueError:
                continue

            if status_enum not in TERMINAL:
                continue  # still running or unknown

            # Fetch entity fresh from DB — use module-level AgenticProcess via
            # globals() to avoid forward-reference issues (class defined below).
            _AgenticProcess = globals().get("AgenticProcess")
            if _AgenticProcess is None:
                return
            proc = await _AgenticProcess.get_by_id(agentic_process_id)
            if proc is None:
                return  # entity deleted

            if proc.status == str(new_status):
                return  # already up to date — WS was already sent

            proc.status = str(new_status)
            await proc.save()
            logger.info(
                "AgenticProcess %s: completion monitor set status=%s",
                agentic_process_id,
                new_status,
            )
            return
        except Exception:
            logger.debug("_poll_for_completion error for %s", agentic_process_id, exc_info=True)


def _build_run_result(proc: "AgenticProcess") -> "RunResult":
    """Build a RunResult from the process state after wait() completes."""
    from flow_sdk.builtin.agentic_process._shared import RunResult

    text = ""
    models_used: list[str] = []
    token_usage: dict | None = None
    if proc.session_id:
        try:
            record = ClaudeSessionRecord.discover_one(proc.session_id)
            if record:
                text = record.last_assistant_text or ""
                models_used = list(record.models_used) if hasattr(record, "models_used") else []
                token_usage = record.token_usage if hasattr(record, "token_usage") else None
        except Exception:
            pass

    status_str = proc.status
    try:
        status_enum = AgenticProcessStatus(status_str)
    except ValueError:
        status_enum = AgenticProcessStatus.COMPLETE

    ok = status_enum not in (AgenticProcessStatus.ERROR, AgenticProcessStatus.INTERRUPTED)
    return RunResult(
        text=text,
        session_id=proc.session_id or "",
        status=status_enum,
        ok=ok,
        duration_ms=None,
        models_used=models_used,
        token_usage=token_usage,
    )


class AgenticProcess(Entity):
    _api_visible = True
    type: str = APIField(default="agentic_process")

    instruction_content: str | None = APIField(default=None)
    source_vfs_path: str | None = APIField(default=None)
    context: dict[str, Any] = APIField(default_factory=dict)
    context_data: dict[str, Any] = APIField(default_factory=dict)
    cli_config: dict[str, Any] = APIField(default_factory=dict)
    workdir: str | None = APIField(default=None)
    favorite_index: int | None = APIField(default=None)
    status: str = APIField(default=AgenticProcessStatus.IDLE.value)
    session_id: str | None = APIField(default=None)
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
    worker_type: WorkerType | None = APIField(default=None, validation_alias="workerType")

    # ── Construction ──────────────────────────────────────────────────────────

    @classmethod
    async def run(
        cls,
        instruction: str,
        workdir: str | None = None,
        **kwargs,
    ) -> "RunResult":
        """One-shot: create → start → send → wait → return RunResult → stop.

        Raises ProcessError if status is error or interrupted.
        """
        from flow_sdk.builtin.agentic_process._shared import ProcessError

        proc = cls(workdir=workdir, **kwargs)
        async with proc:
            await proc.send(instruction)
            await proc.wait()
            result = _build_run_result(proc)
        if not result.ok:
            raise ProcessError(status=result.worker_status, session_id=result.session_id)
        return result

    @classmethod
    def resume(
        cls,
        session_id: str,
        workdir: str | None = None,
        **kwargs,
    ) -> "AgenticProcess":
        """Factory: pre-bake resume cli_config. start() injects --resume <session_id>.

        Fork chain is walked automatically to find the nearest transcript on disk.
        """
        cmd = ClaudeCliOptions(resume=True)
        proc = cls(workdir=workdir, **kwargs)
        proc.session_id = session_id
        proc.cli_config = cmd.to_json()
        return proc

    @classmethod
    def fork(
        cls,
        session_id: str,
        workdir: str | None = None,
        **kwargs,
    ) -> "AgenticProcess":
        """Factory: pre-bake fork cli_config. start() injects --resume <src> --fork-session."""
        cmd = ClaudeCliOptions(fork_session_id=session_id)
        proc = cls(workdir=workdir, **kwargs)
        proc.cli_config = cmd.to_json()
        return proc

    async def __aenter__(self) -> "AgenticProcess":
        await self.start()
        return self

    async def __aexit__(self, *_) -> None:
        await self.exit()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(
        self,
        instruction: str | None = None,
        visible: bool | None = None,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Open (or reopen) this AgenticProcess — starts fresh or resumes automatically.

        Covers all cases:
        - Fresh open (no previous session): spawns Claude with --session-id.
        - Reopen after server restart (stale shell, dead PTY): Shell.start() detects
          the dead PTY, cleans up, and spawns Claude with --resume.
        - Idempotent call on live process: Shell.start() detects alive PTY and returns
          without re-spawning.
        """
        try:
            self.session_id = self.session_id or str(uuid4())

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

            await self.get_project()

            # Build the CLI command from cli_config + entity fields
            cmd = self.cli_options

            # Server-restart resume: process had a shell but cli_config didn't encode resume
            if not cmd.resume and self.shell_id:
                cmd.resume = self._is_exist_claude_resume_session(self.session_id)

            # Fork: resolve chain to nearest ancestor with a transcript on disk
            if cmd.fork_session_id:
                cmd.fork_session_id = await self._find_resumable_session(cmd.fork_session_id)

            # When resuming, ensure CLAUDE_PROJECT_DIR points to where the session lives.
            if cmd.resume and self.session_id:
                session_rec = self._discover_claude_record_session(self.session_id)
                if session_rec and session_rec.cwd:
                    cmd.env_vars["CLAUDE_PROJECT_DIR"] = session_rec.cwd
                    cmd.workdir = session_rec.cwd

            # Runtime env injection (process identity for hook routing)
            cmd.add_env(
                "FLOWPAD_EXECUTION_SCOPE",
                json.dumps([{"type": self.get_type(), "id": self.id}]),
            )

            is_resume = cmd.resume

            # Get existing shell or create a new one
            shell = await self._get_or_create_shell()
            self.shell_id = shell.id
            self.status = AgenticProcessStatus.RUNNING.value
            if visible is not None:
                self.visible = visible
            # Save session_id + shell_id BEFORE launching Claude so that
            # the Stop hook's _mark_process_complete() can find this entity even
            # when fast bash-only tasks complete before the post-launch save.
            await self.save()
            on_exit = self._make_pty_exit_callback()
            await shell.start(on_exit=on_exit)
            worker_is_alive = await shell.worker_alive()
            if not worker_is_alive:
                execution_info = await shell.launch(cmd, instruction=instruction)
                logger.info(
                    "AgenticProcess %s worker launched: pid=%s name=%r",
                    self.id, execution_info.pid, execution_info.name,
                )
                # Start background task to detect completion via transcript polling.
                asyncio.create_task(
                    _poll_for_completion(self.id, self.session_id),
                    name=f"completion-monitor-{self.id[:8]}",
                )

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": AgenticProcessStatus.RUNNING.value,
                    "shell_id": self.shell_id,
                    "session_id": self.session_id,
                    "compute_node_id": self.compute_node_id,
                    "shell": shell.model_dump(mode="json"),
                    "is_resume": is_resume,
                    "worker_pid": shell.worker_pid,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} start error: {e}")
            self.shell_id = None
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.post(action_name="exit")
    async def exit(self) -> ApiSuccessResponse | ApiFailResponse:
        """Kill worker process but keep shell entity alive (status=idle). Use before restart."""
        if not self.shell_id:
            return ApiFailResponse(message="No active shell session")

        try:
            from flow_sdk.builtin.shell import Shell

            shell = await Shell.get_by_id(self.shell_id)
            if shell:
                self.context_data = {**self.context_data, "_prev_tab_order": shell.tab_order}

            # Set flag so the PTY exit callback knows to preserve shell_id.
            # Clear sidecar but NOT shell_id — shell entity stays alive for restart.
            self.context_data = {**self.context_data, "_shell_exit_pending": True}
            self.sidecar_shell_id = None
            self.status = AgenticProcessStatus.INTERRUPTED.value
            await self.save()

            if shell:
                await shell.terminate_worker()  # graceful SIGTERM → SIGKILL
                await shell.stop()              # kill PTY, set status=idle
                logger.info("AgenticProcess %s: exited (shell entity %s preserved)", self.id, self.shell_id)
            else:
                logger.warning("AgenticProcess %s: Shell entity %s not found on exit", self.id, self.shell_id)

            logger.info(
                "AgenticProcess %s: exited (session_id preserved: %s)",
                self.id,
                self.session_id,
            )

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": AgenticProcessStatus.IDLE.value,
                    "shell_id": self.shell_id,
                    "session_id": self.session_id,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} exit error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="restart")
    async def http_restart(self) -> ApiSuccessResponse | ApiFailResponse:
        """exit() + start(). Shell entity is preserved and reused."""
        exit_result = await self.exit()
        if isinstance(exit_result, ApiFailResponse) and "No active shell" not in exit_result.message:
            return exit_result
        return await self.start()

    async def wait(self, timeout: float | None = None) -> None:
        """Block until status reaches a terminal state (complete / error / interrupted).

        Polling interval: 2s. Raises TimeoutError if timeout elapses first.
        """
        from flow_sdk.fs_records.agent_status import is_terminal
        deadline = (asyncio.get_event_loop().time() + timeout) if timeout else None
        while True:
            try:
                current = AgenticProcessStatus(self.status)
                if is_terminal(current):
                    return
            except ValueError:
                pass
            if deadline and asyncio.get_event_loop().time() > deadline:
                raise TimeoutError(f"Process did not reach terminal state within {timeout}s")
            await asyncio.sleep(2.0)

    # ── Execution ─────────────────────────────────────────────────────────────

    async def prompt(self, instruction: str) -> ApiSuccessResponse | ApiFailResponse:
        """Schedule a Claude run with *instruction* and return immediately.

        Routing:
          worker alive → write instruction to PTY stdin (continues session)
          worker dead  → call start(instruction) (fresh or auto-resume)
        """
        if await self.is_running():
            await self.send(instruction)
            return ApiSuccessResponse(data={"status": "sent"})
        return await self.start(instruction=instruction)

    async def send(self, data: str | bytes) -> None:
        """Write text or raw bytes to the live PTY stdin.

        - str: sent via shell.write() (bracketed paste + \\r)
        - bytes: sent directly to the PTY without modification (use for control
          sequences like b"\\x1b" where appending \\r would break the intent)

        Requires start() to have been called first.
        """
        shell = await self.shell()
        if not shell:
            raise ValueError("No shell linked — call start() first")
        if isinstance(data, bytes):
            await shell.write_raw(data)
        else:
            await shell.write(data)

    def stream(self, instruction: str):
        """Stream live output as StreamEvent items from the JSONL transcript.

        Not yet implemented — requires async JSONL tailing (L effort).
        """
        raise NotImplementedError(
            "stream() is not yet implemented. "
            "For now: await proc.send(instruction); await proc.wait(); "
            "then read the transcript via ClaudeSessionRecord."
        )

    @action.post(action_name="execute")
    async def _http_execute(
        self,
        instruction: str | None = None,
        session_id: str | None = None,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Execute an instruction on this process.

        Called by the TS SDK's executeInstruction(). Delegates to prompt()
        which handles both fresh-start and send-to-running-process cases.
        """
        if not instruction:
            return ApiFailResponse(message="instruction is required")
        if session_id:
            self.session_id = session_id
        result = await self.prompt(instruction)
        if isinstance(result, ApiFailResponse):
            return result
        return result if isinstance(result, ApiSuccessResponse) else ApiSuccessResponse(data={"status": "ok"})

    # ── Plan mode ─────────────────────────────────────────────────────────────

    @action.post(action_name="execute-plan")
    async def execute_plan(
        self,
        file_path: str,
        clear_context: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """Tell Claude to execute the plan.

        If clear_context=True, inject '/clear' first.
        Sets the plan auto-approve flag so that when ExitPlanMode is called,
        the hook handler can auto-approve the PermissionRequest once.
        """
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            if clear_context:
                await self.inject("/clear")
                await asyncio.sleep(1)

            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>, if any, then execute plan"
            await self.inject(prompt)
            await asyncio.sleep(1.5)

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
        """Tell Claude to update the plan based on <plan-note> annotations."""
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>"
            await self.inject(prompt)

            return ApiSuccessResponse(data={"ok": True})
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} update-plan error: {e}")
            return ApiFailResponse(message=str(e))

    # ── State ─────────────────────────────────────────────────────────────────

    @property
    def cli_options(self) -> "ClaudeCliOptions":
        """Deserialize cli_config into a live ClaudeCliOptions.

        session_id and workdir are injected from entity fields (not stored in cli_config).
        Bundled system_assets dir is always prepended; additional_dirs follow.
        Callers add runtime env vars via add_env() before calling to_shell_string().
        """
        import flow_sdk
        cmd = ClaudeCliOptions.from_json(self.cli_config)
        cmd.session_id = self.session_id
        cmd.workdir = self.workdir
        if cmd.workdir:
            cmd.env_vars.setdefault("CLAUDE_PROJECT_DIR", cmd.workdir)
        core_dir = str(Path(flow_sdk.__file__).parent / "system_assets" / "core")
        extra = [d for d in (self.additional_dirs or []) if d != core_dir]
        cmd.add_dirs = [core_dir] + extra
        return cmd

    def to_dict(self) -> dict:
        d = super().to_dict()
        computed = self._discover_status_from_transcript()
        d["worker_status"] = str(computed) if computed else AgenticProcessStatus.IDLE.value
        return d

    def _discover_status_from_transcript(self) -> AgenticProcessStatus | None:
        """Derive status from the Claude session transcript record."""
        session = self._discover_claude_record_session(self.session_id)
        return session.status if session else None

    @action.all(action_name="status")
    async def get_status(self):
        """Return current app status and computed worker_status from transcript."""
        worker_status = self._discover_status_from_transcript()
        return ApiSuccessResponse(data={
            "status": self.status,
            "worker_status": str(worker_status) if worker_status else AgenticProcessStatus.IDLE.value,
        })

    @property
    def is_idle(self) -> bool:
        """True when not actively running."""
        return self.status != AgenticProcessStatus.RUNNING.value

    async def is_running(self) -> bool:
        """True when the Claude CLI worker process is actively running in the PTY."""
        shell = await self.shell()
        if shell is None:
            return False
        return await shell.worker_alive()

    # ── Advanced API ──────────────────────────────────────────────────────────

    async def shell(self) -> "Shell | None":
        """The Shell entity for this process. None until start() is called.

        Async method — requires Shell.get_by_id() DB lookup.
        Use for reading raw PTY output, attaching WS viewers, inspecting worker PID.
        """
        if not self.shell_id:
            return None
        from flow_sdk.builtin.shell import Shell
        return await Shell.get_by_id(self.shell_id)

    async def set_session_id(self, session_id: str) -> None:
        """Bind this process to an existing Claude session before start()."""
        self.session_id = session_id
        await self.save()

    async def inject(self, message: str) -> None:
        """Inject a message directly into the live PTY, bypassing prompt() routing.

        Sends Escape first (200ms wait) to dismiss any active numeric prompt,
        then sends message as keystrokes.
        Use for: /clear, /rename, custom slash commands, debugging PTY state.
        """
        if not self.shell_id:
            logger.warning("AgenticProcess %s: no active shell, cannot inject message", self.id)
            return

        await self.send(b"\x1b")
        await asyncio.sleep(0.2)

        logger.info("AgenticProcess %s: injecting message: %s", self.id, message[:80])
        await self.send(message)

    @action.post(action_name="add-dir")
    async def add_dir(self, path: str) -> "ApiResponse":
        """Append a directory to additional_dirs (passed to Claude via --add-dir)."""
        from flow_sdk.responses.response import ApiSuccessResponse
        if path not in (self.additional_dirs or []):
            self.additional_dirs = list(self.additional_dirs or []) + [path]
            await self.save()
        return ApiSuccessResponse()

    # ── Close ─────────────────────────────────────────────────────────────────

    async def close(self) -> bool:
        """Terminate this process and close its linked shell.

        Returns True on success, False if already terminated or on error.
        """
        logger.info(f"AgenticProcess {self.id}: close")

        try:
            shell_id = self.shell_id
            if shell_id:
                self.shell_id = None
                self.sidecar_shell_id = None
            self.status = AgenticProcessStatus.INTERRUPTED.value
            await self.save()

            if shell_id:
                from flow_sdk.builtin.shell import Shell
                shell: Shell = await Shell.get_by_id(shell_id)
                if shell:
                    await shell.close()

            return True

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} close error: {e}")
            return False

    # ── HTTP actions ──────────────────────────────────────────────────────────

    @action.post(action_name="open")
    async def _http_open(self) -> ApiSuccessResponse | ApiFailResponse:
        """HTTP: Start PTY and set status=running.

        POST body: {instruction?, visible?, session_id?}
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        instruction = body.get("instruction")
        visible = body.get("visible")
        # Support legacy worker_session_id in POST body for older clients
        session_id_override = body.get("session_id") or body.get("worker_session_id")
        if session_id_override:
            self.session_id = session_id_override
        return await self.start(instruction=instruction, visible=visible)

    @action.post(action_name="close")
    async def _http_close(self) -> ApiSuccessResponse | ApiFailResponse:
        """HTTP: Permanent teardown — kill worker + delete shell entity.

        Delegates to close(), then returns an ApiResponse for the HTTP layer.
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

    # ── Project ───────────────────────────────────────────────────────────────

    async def get_project(self) -> None:
        """Resolve project_id, workdir, and project_encoded_name from DB ancestry."""
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

    # ── Internals ─────────────────────────────────────────────────────────────

    def _is_exist_claude_resume_session(self, session_id: str | None) -> bool:
        """Check if there's a resumable Claude session for this agentic process."""
        return self._discover_claude_record_session(session_id) is not None

    def _discover_claude_record_session(self, session_id: str | None) -> ClaudeSessionRecord | None:
        """Discover the ClaudeSessionRecord associated with this agentic process's session_id."""
        if not session_id:
            return None
        return ClaudeSessionRecord.discover_one(session_id)

    async def _find_resumable_session(self, session_id: str) -> str | None:
        """Walk up the fork chain to find a session ID with a transcript on disk."""
        candidate: str | None = session_id
        seen: set[str] = set()
        while candidate and candidate not in seen:
            seen.add(candidate)
            if ClaudeSessionRecord.discover_one(candidate) is not None:
                return candidate
            procs = await AgenticProcess.get_all()
            parent = next((p for p in procs if p.session_id == candidate), None)
            candidate = parent.context_data.get("resume_session_id") if parent else None
        return None

    async def _get_or_create_shell(self) -> "Shell":
        """Get existing shell by shell_id, or create a new one."""
        from flow_sdk.builtin.shell import Shell

        if self.shell_id:
            shell = await Shell.get_by_id(self.shell_id)
            if shell:
                return shell

        prev = self.context_data.pop("_prev_tab_order", None)
        tab_order = prev if prev is not None else await Shell.next_tab_order()

        is_resume = self._is_exist_claude_resume_session(self.session_id) if self.session_id else False
        is_fork = bool(getattr(self, 'cli_options', None) and self.cli_options.fork_session_id)
        session_label = 'fork' if is_fork else 'resume' if is_resume else 'new'
        session_name = f"Claude - {self.session_id[:8]} ({session_label})" if self.session_id else "Claude"

        cn_id = self.compute_node_id
        if cn_id and "-" in cn_id:
            cn_id = cn_id.split("-", 1)[1]

        shell = Shell(
            compute_node_id=cn_id,
            name=session_name,
            workdir=self.workdir,
            tab_order=tab_order,
        )
        await shell.save()
        return shell

    def _make_pty_exit_callback(self) -> Callable[[int | None], None]:
        """Return a thread-safe callback that updates process status when the PTY exits."""
        main_loop = asyncio.get_running_loop()
        agentic_process_id = self.id
        session_id = self.session_id
        shell_id = self.shell_id

        def _on_pty_exit(exit_code: int | None) -> None:
            logger.info("AgenticProcess %s: PTY exited with code %s", agentic_process_id, exit_code)

            async def _update_state():
                try:
                    proc = await AgenticProcess.get_by_id(agentic_process_id)
                    if not proc:
                        return
                    if not proc.shell_id:
                        return  # close() already handled it
                    if proc.context_data.get("_shell_exit_pending"):
                        # exit() was called — shell entity stays alive, just clear the flag
                        proc.context_data = {k: v for k, v in proc.context_data.items() if k != "_shell_exit_pending"}
                        await proc.save()
                        return
                    proc.shell_id = None
                    proc.sidecar_shell_id = None
                    if proc.status == AgenticProcessStatus.RUNNING.value:
                        proc.status = AgenticProcessStatus.INTERRUPTED.value
                    await proc.save()

                    if session_id:
                        _pty_title: str | None = None
                        if shell_id:
                            try:
                                from flow_sdk.builtin.faas.pty_actions import get_pty_session_title
                                _pty_title = get_pty_session_title(shell_id)
                            except Exception:
                                pass
                        asyncio.create_task(_index_session_on_close(session_id, pty_title=_pty_title))
                except Exception as exc:
                    logger.warning("AgenticProcess %s: on_exit update failed: %s", agentic_process_id, exc)
            asyncio.run_coroutine_threadsafe(_update_state(), main_loop)

        return _on_pty_exit

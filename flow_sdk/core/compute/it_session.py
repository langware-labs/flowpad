"""IT Sessions: the agent owner's IT message, run once on this box and forgotten (``it-session/run``).

The hub reaches this box over its cookie gate (``ComputeNode.http``) with ``{call_id, text, attachments,
answer_shape, timeout_s}``. The run is a THROWAWAY session:

- a private temp folder holds the attachments and the result file, never the project;
- the agent runs headless in the box's project (it reads the student's work there);
- afterwards the temp folder, the AgenticProcess row, its records folder and its transcript are deleted —
  the box keeps no trace, and nothing lands in its StreamInbox, conversations or flow_message rows;
- it never runs while a person is signed in, and a sign-in mid-run cancels it (``_watch_sign_in``);
- a backend that died mid-run leaves a temp folder behind: ``sweep_leftovers`` clears it at startup.

The gates (preference on, nobody signed in) are ``refusal``; the route answers 409 with its reason.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from flow_sdk.preferences import read_instance_pref, write_instance_pref

logger = logging.getLogger(__name__)

#: Mirrors ``PrefKey.IT_SESSIONS`` (ts_sdk/src/preferences/prefRegistry.ts) and its seeded default in bootstrap.
PREF_IT_SESSIONS = "preferences.general.it_sessions"
DEFAULT_IT_SESSIONS = False
#: Where the throwaway folders live, under the instance dir so a startup sweep finds every leftover.
SESSIONS_DIR = "it-sessions"
#: The receipt key the agent writes its answer value under.
VALUE_KEY = "value"
OUTCOME_KEY = "outcome"
#: The agent an IT message runs as (the same one-shot runner a prompt call uses).
IT_AGENT = "prompt-runner"
#: How often a run checks that nobody signed in meanwhile.
SIGN_IN_POLL_SECONDS = 2.0
DEFAULT_TIMEOUT_SECONDS = 900.0
MAX_TIMEOUT_SECONDS = 3600.0

OFF = "off"
SIGNED_IN = "signed_in"
CANCELLED_BY_SIGN_IN = "Stopped: someone signed in on this machine, so the IT session was cancelled."


@dataclass
class ItAnswer:
    answer: str
    value: Optional[Any] = None
    #: False when the session failed (the agent errored, the budget refused, no answer in the asked shape): the hub
    #: then records the reply as failed with ``answer`` as its reason, never as done.
    ok: bool = True

    def as_data(self) -> dict:
        return {"answer": self.answer, "value": self.value, "ok": self.ok}


class ItSessionCancelled(Exception):
    """A person signed in while the IT session ran."""


# ── gates ────────────────────────────────────────────────────────────────


def it_sessions_on() -> bool:
    return read_instance_pref(PREF_IT_SESSIONS, DEFAULT_IT_SESSIONS) is True


def set_it_sessions(on: bool) -> bool:
    """Write the IT Sessions preference (the same file the Preferences screen edits). Answers the stored value."""
    write_instance_pref(PREF_IT_SESSIONS, bool(on))
    return it_sessions_on()


def _is_agent_identity(user: Any) -> bool:
    """A box an AGENT is logged in as (its own Identity) has no person at the keyboard."""
    if not isinstance(user, dict):
        return False
    kind = str(user.get("kind") or user.get("type") or user.get("principal_type") or "").lower()
    if kind in ("identity", "agent"):
        return True
    ident = str(user.get("id") or user.get("typeid") or "")
    return ident.startswith(("identity-", "identity_", "identity:"))


def person_signed_in() -> bool:
    """Whether a PERSON is logged in to the hub here — the ``/api/v1/cloud/status`` login block."""
    from flow_sdk.cloud_client.auth_state import login_block  # noqa: PLC0415
    from flow_sdk.cloud_client.auth_status import HubLoginStatus  # noqa: PLC0415

    login = login_block()
    if login.get("status") != HubLoginStatus.LOGGED_IN.value:
        return False
    return not _is_agent_identity(login.get("user"))


def status() -> dict:
    return {"on": it_sessions_on(), "signed_in": person_signed_in()}


def refusal() -> Optional[str]:
    """``off`` / ``signed_in`` when a run must be refused, else None."""
    if not it_sessions_on():
        return OFF
    if person_signed_in():
        return SIGNED_IN
    return None


# ── the throwaway folder ────────────────────────────────────────────────


def sessions_root() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / SESSIONS_DIR


def sweep_leftovers() -> int:
    """Delete every IT session folder a dead run left behind. Called at startup; answers how many went."""
    root = sessions_root()
    if not root.is_dir():
        return 0
    count = 0
    for child in root.iterdir():
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
        count += 1
    return count


def _safe_name(name: str, index: int) -> str:
    leaf = Path(str(name or "")).name.strip()
    return leaf if leaf and leaf not in (".", "..") else f"attachment-{index}"


def write_attachments(folder: Path, attachments: list[dict]) -> list[Path]:
    """Decode each ``{name, content_b64}`` into ``folder`` (leaf names only: nothing escapes it)."""
    folder.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for index, att in enumerate(attachments or []):
        if not isinstance(att, dict):
            continue
        path = folder / _safe_name(att.get("name", ""), index)
        path.write_bytes(base64.b64decode(str(att.get("content_b64") or ""), validate=False))
        written.append(path)
    return written


def build_prompt(text: str, attachments: list[Path], result_path: Path, answer_shape: Optional[dict]) -> str:
    from flow_sdk.core.compute.receipt import result_contract  # noqa: PLC0415

    files = ""
    if attachments:
        listed = "\n".join(f"  - {p}" for p in attachments)
        files = f"\n\nThe message came with these files (read them, do not copy them into the project):\n{listed}"
    note = (
        "\n\nThis is an IT session sent by this machine's owner. Read what you need; do not change the project, "
        "and do not start conversations or send messages."
    )
    if answer_shape is not None:
        contract = result_contract(result_path, VALUE_KEY, answer_shape)
        shape = (
            f"\n\nPut your answer under `data.{VALUE_KEY}` as a JSON value matching this JSON Schema exactly, "
            "and say it in one sentence as `summary`."
        )
        return text + files + note + shape + contract
    return text + files + note + result_contract(result_path, OUTCOME_KEY, "<your answer, in a few sentences>")


def shape_mismatch(value: Any, answer_shape: dict) -> Optional[str]:
    """Why ``value`` does not match the JSON Schema ``answer_shape``, or None when it does."""
    import jsonschema  # noqa: PLC0415

    try:
        jsonschema.validate(value, answer_shape)
    except jsonschema.ValidationError as exc:
        return exc.message
    except jsonschema.SchemaError as exc:
        return f"the answer shape is not a valid JSON Schema: {exc.message}"
    return None


def read_answer(result_path: Path, answer_shape: Optional[dict], fallback: str) -> ItAnswer:
    from flow_sdk.core.compute.receipt import read_step_result  # noqa: PLC0415

    output = VALUE_KEY if answer_shape is not None else OUTCOME_KEY
    receipt = read_step_result(result_path, output=output)
    if not receipt.ok:
        return ItAnswer(answer=receipt.summary or receipt.error or fallback, value=None, ok=False)
    if answer_shape is None:
        text = receipt.value if isinstance(receipt.value, str) else ""
        return ItAnswer(answer=text or receipt.summary or fallback, value=None)
    why = shape_mismatch(receipt.value, answer_shape)
    if why is not None:
        return ItAnswer(
            answer=f"{receipt.summary or 'Answered'} — but the answer does not match its shape: {why}", ok=False
        )
    return ItAnswer(answer=receipt.summary or "Done.", value=receipt.value)


# ── cleanup ─────────────────────────────────────────────────────────────


async def forget_process(executor: str) -> None:
    """Delete the process this run created: its row, its transcript (``AgenticProcess.delete``), its records."""
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    if not executor or not TypeId.is_typeid(executor):
        return
    process_id = TypeId(executor).id
    try:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415

        process = await AgenticProcess.get_by_typeid(executor)
        if process is not None:
            await process.delete()
    except Exception:  # noqa: BLE001 — the folder below still goes
        logger.warning("IT session: could not delete process %s", executor, exc_info=True)
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        shutil.rmtree(get_instance_settings().records_root / "agentic_process" / str(process_id), ignore_errors=True)
    except Exception:  # noqa: BLE001
        logger.warning("IT session: could not delete the records of %s", executor, exc_info=True)


# ── the run ─────────────────────────────────────────────────────────────

#: Runs in flight: call id -> task. A sign-in cancels them (``_watch_sign_in``).
_RUNNING: dict[str, asyncio.Task] = {}


async def project_workdir(project: Optional[dict] = None) -> Path:
    """The project the IT session runs in: the one the hub names (the agent's own project, by id, else by folder
    name), else the project the hub opened here, else the scratch folder. A public box has no opening project and
    holds a starter project too, so guessing "the first project" lands in the wrong folder."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.remote_worker_session import scratch_workdir  # noqa: PLC0415
    from flow_sdk.config import is_system_project_path  # noqa: PLC0415
    from flow_sdk.fs_store.operations.all_projects import get_cached_projects  # noqa: PLC0415
    from flow_sdk.server.state import _read_opening_project  # noqa: PLC0415

    named = project or {}
    candidates = [await Project.get_one({"id": named["id"]})] if named.get("id") else []
    if not any(candidates) and named.get("name"):
        candidates = [
            p
            for p in await get_cached_projects()
            if p.fs_storage_mount_path and Path(p.fs_storage_mount_path).name == named["name"]
        ]
    if not any(candidates) and _read_opening_project().get("project_id"):
        candidates = [await Project.get_one({"id": _read_opening_project()["project_id"]})]
    if not any(candidates):
        candidates = [
            p
            for p in await get_cached_projects()
            if p.fs_storage_mount_path and not is_system_project_path(p.fs_storage_mount_path)
        ]
    for project in candidates:
        folder = getattr(project, "fs_storage_mount_path", None) if project else None
        if folder and Path(folder).is_dir():
            return Path(folder)
    return scratch_workdir()


async def _watch_sign_in(task: asyncio.Task, signed_in=person_signed_in) -> None:
    while not task.done():
        await asyncio.sleep(SIGN_IN_POLL_SECONDS)
        if signed_in():
            task.cancel(CANCELLED_BY_SIGN_IN)
            return


async def run_it_session(
    *,
    call_id: str,
    text: str,
    attachments: Optional[list[dict]] = None,
    answer_shape: Optional[dict] = None,
    timeout_s: Optional[float] = None,
    workdir: Optional[Path] = None,
    project: Optional[dict] = None,
) -> ItAnswer:
    """Run one IT message headless and answer it. Never raises; always leaves nothing behind."""
    from flow_sdk.core.compute.process_step import ProcessProgress, launch_step_process  # noqa: PLC0415

    root = sessions_root()
    root.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="it-", dir=root))
    executors: set[str] = set()

    def seen(progress: ProcessProgress) -> None:
        if progress.executor:
            executors.add(progress.executor)

    timeout = min(float(timeout_s or DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS)
    try:
        files = write_attachments(tmp / "attachments", attachments or [])
        result_path = tmp / "result.json"
        where = workdir or await project_workdir(project)
        run = asyncio.ensure_future(
            launch_step_process(
                agent=IT_AGENT,
                prompt=build_prompt(text, files, result_path, answer_shape),
                name="IT session",
                workdir=where,
                timeout_seconds=timeout,
                on_status=seen,
                remember_prompt=False,
                context_data={"it_session": call_id, "call_id": call_id},
            )
        )
        _RUNNING[call_id] = run
        watcher = asyncio.ensure_future(_watch_sign_in(run))
        try:
            said = await run
        except asyncio.CancelledError:
            if person_signed_in():
                return ItAnswer(answer=CANCELLED_BY_SIGN_IN, ok=False)
            raise
        finally:
            watcher.cancel()
        if said.executor:
            executors.add(said.executor)
        if not said.ok:
            return ItAnswer(answer=said.detail or "The IT session did not finish.", ok=False)
        return read_answer(result_path, answer_shape, said.detail or "Done.")
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — an answer, never a silent death
        logger.exception("IT session %s crashed", call_id)
        return ItAnswer(answer=f"The IT session failed: {exc}", ok=False)
    finally:
        _RUNNING.pop(call_id, None)
        for executor in executors:
            await forget_process(executor)
        shutil.rmtree(tmp, ignore_errors=True)

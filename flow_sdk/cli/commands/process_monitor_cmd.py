"""``flow process monitor`` / ``monitor-nudge`` / ``unmonitor`` -- a session's goal, watched on a clock.

``flow process monitor --name <n> --goal "<g>" --cron "*/10 * * * *"``

Watch a session's goal: a trigger asset in its project runs ``flow process monitor-nudge <key>``, which
asks a fork of the session whether the goal is met and prompts the session to continue until it is.
``flow process unmonitor <key>`` removes it (docs/automations.md, "A monitor on a session's goal").

The commands register on ``process_cmd.process_app``; ``process_cmd`` imports this module so they are
part of ``flow process``.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, NamedTuple, Optional

import requests
import typer
from pydantic import BaseModel, ConfigDict, ValidationError
from typing_extensions import Annotated

from flow_sdk.capsules.atomic import atomic_write
from flow_sdk.cli.commands._common import (
    EXIT_CONNECTION_ERROR,
    EXIT_INVALID_ARG,
    delete_graph_json,
    discover_port,
    fail,
    get_graph_json,
    graph_url,
    local_post,
    ok,
    patch_graph_json,
    post_graph_json,
    resolve_process_id,
    run_async,
)
from flow_sdk.cli.commands.process_cmd import EXIT_ACTION_FAILED, _action_failed, process_app
from flow_sdk.schema.data_spec.monitor_spec import MonitorSpec, NudgeLogEntry

# ── monitor: a goal watched on a clock ──────────────────────────────────────
#
# ``monitor`` writes two ASSETS into the process's project, side by side under one key
# ``<process id>_monitor_<name>``: the Monitor (``agentic-assets/monitor/<key>/monitor.json``, the goal)
# and its cron trigger (``agentic-assets/trigger/<key>/trigger.json``), which runs ``monitor-nudge``.
# The nudge asks a fork of the session whether the goal is met, and either prompts the session to go on
# or ends the monitor. ``unmonitor`` removes both.

EXIT_NOT_FOUND = 4
_NUDGE_RETRIES = 3
_REPLY_FORMAT = '{"answer": "goal_met" | "stop_condition_reached" | "continue_to_work"}'


class MonitorVerdict(BaseModel):
    """What the asked session must answer -- nothing more, nothing else."""

    model_config = ConfigDict(extra="forbid")

    answer: Literal["goal_met", "stop_condition_reached", "continue_to_work"]

    @staticmethod
    def from_raw_agent_response(raw_agent_response: str) -> "MonitorVerdict":
        """The agent's reply as a ``MonitorVerdict``: its JSON object, even inside a ``` fence or a sentence.
        Raises ``ValidationError`` when the reply holds no valid verdict."""
        text = raw_agent_response.strip()
        start, end = text.find("{"), text.rfind("}")
        return MonitorVerdict.model_validate_json(text[start:end + 1] if 0 <= start < end else text)


class GraphRefused(Exception):
    """A graph call the server answered with a failure -- raised by ``raise_graph_refused`` so a ``try_``
    helper can answer None instead of exiting."""


def raise_graph_refused(status_code: int, body: dict) -> None:
    raise GraphRefused(str(body.get("message") or body.get("error") or f"HTTP {status_code}"))


def _not_found(what: str):
    def on_error(status_code: int, body: dict) -> None:
        if status_code == 404:
            fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No {what}.")
        _action_failed(status_code, body)

    return on_error


def _process_and_folders(port: int, process_id: str, name: str) -> tuple[dict, Path, Path]:
    """The session, and the monitor's trigger and Monitor folders under its project (which may not exist yet)."""
    process = get_graph_json(graph_url(port, f"agentic_process/{process_id}"),
                              on_error=_not_found(f"session {process_id}"))
    if not process:
        fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No session {process_id}.")
    project_id = process.get("project_id")
    project = get_graph_json(graph_url(port, f"project/{project_id}"),
                              on_error=_not_found(f"project {project_id}")) if project_id else None
    mount = (project or {}).get("fs_storage_mount_path")
    if not mount:
        fail(EXIT_ACTION_FAILED, "NO_PROJECT_FOLDER",
              f"Session {process_id} has no project folder to keep a monitor in.")
    assets, key = Path(mount) / "agentic-assets", MonitorSpec.make_key(process_id, name)
    return process, assets / "trigger" / key, assets / "monitor" / key


def try_index_monitor_asset(port: int, folder: Path, type_name: str) -> Optional[str]:
    """Index one of a monitor's asset folders (a trigger is armed by it): its row's id, or None when it did
    not index. Re-indexing an unchanged folder answers the same id, so this is also how the rows are found."""
    try:
        data = post_graph_json(graph_url(port, "compute_node/@local/fs-records/index"), None,
                                params={"type": type_name, "path": str(folder.resolve())}, timeout=120,
                                on_error=raise_graph_refused)
    except GraphRefused:
        return None
    typeid = next(iter(data.get("typeids") or []), "")
    return typeid.removeprefix(f"{type_name}-") or None


def try_remove_monitor(port: int, trigger_folder: Path, monitor_folder: Path) -> Optional[dict]:
    """The trigger first (it stops firing), then the Monitor. For each: folder, then row -- a row whose
    folder is still on disk comes back with the next index. The removed rows' ids, or None when one could
    not be found or deleted."""
    removed = {}
    for type_name, folder in (("trigger", trigger_folder), ("monitor", monitor_folder)):
        if folder.is_dir():
            row_id = try_index_monitor_asset(port, folder, type_name)
            if row_id is None:
                return None
            shutil.rmtree(folder)
            try:
                delete_graph_json(graph_url(port, f"{type_name}/{row_id}"), on_error=raise_graph_refused)
            except GraphRefused:
                return None
            removed[f"{type_name}_id"] = row_id
    return removed


@process_app.command(
    "monitor",
    help=(
        "Watch a session's goal: on a cron mask (--cron '*/10 * * * *'), a fork of the session is asked "
        "whether the goal is met or the stop condition reached. Not yet: the session is prompted to continue. Met or reached: the "
        "monitor ends, quietly. Kept in the session's project as a Monitor and its trigger; "
        "`unmonitor <key>` removes both."
    ),
)
def monitor_process(
    name: Annotated[str, typer.Option("--name", "-n", help="Names this monitor (letters, digits, '-', '_').")],
    cron: Annotated[str, typer.Option("--cron", "-c", help="When to check: a crontab mask ('*/10 * * * *').")],
    goal: Annotated[Optional[str], typer.Option("--goal", "-g", help="What done looks like.")] = None,
    stop_condition: Annotated[
        Optional[str], typer.Option("--stop-condition", "-s", help="When to stop even if the goal is not met.")
    ] = None,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help="Defaults to the current session.")] = None,
) -> None:
    # Everything that can be checked here is checked before anything is asked of the server.
    if not MonitorSpec.NAME_RE.fullmatch(name):
        fail(EXIT_INVALID_ARG, "BAD_NAME", f"{name!r} cannot name a monitor: use up to 40 letters, digits, '-' or '_'.")
    goal, stop_condition = (goal or "").strip(), (stop_condition or "").strip()
    if not (goal or stop_condition):
        fail(EXIT_INVALID_ARG, "MISSING_GOAL", "Give --goal, --stop-condition, or both.")
    from flow_sdk.automations.spec_file import SpecFileError, validate  # noqa: PLC0415

    process_id = resolve_process_id(process)
    key = MonitorSpec.make_key(process_id, name)
    try:
        # The automation-file check the server runs: the document, then the clock as the scheduler reads it.
        spec = validate({
            "name": f"Monitor {name}",
            "description": goal or stop_condition,
            # One machine's session: nothing to offer a clone of the project.
            "recommended": False,
            "schedule": {"every": "cron", "expr": cron},
            "then": {"run_script": f"flow process monitor-nudge {key}"},
        })
    except SpecFileError as e:
        fail(EXIT_INVALID_ARG, "BAD_CRON", f"Cannot use the cron mask {cron!r}: {e}")

    from flow_sdk.assets.asset import Asset  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    port = discover_port()
    _, folder, monitor_folder = _process_and_folders(port, process_id, name)
    if folder.exists() or monitor_folder.exists():
        fail(EXIT_INVALID_ARG, "ALREADY_MONITORED",
              f"Session {process_id} already has a monitor named {name!r}; `unmonitor` it first.")
    try:
        folder.mkdir(parents=True)
        (folder / "trigger.json").write_text(
            json.dumps(spec.model_dump(mode="json", exclude_defaults=True, by_alias=True), indent=2) + "\n",
            encoding="utf-8",
        )
        Asset.create(monitor_folder, type=EntityType.MONITOR, spec=MonitorSpec(
            name=name, agentic_process_id=process_id, goal=goal, stop_condition=stop_condition, cron=cron,
        ))
        monitor_id = try_index_monitor_asset(port, monitor_folder, "monitor")
        trigger_id = try_index_monitor_asset(port, folder, "trigger")
        if monitor_id is None or trigger_id is None:
            fail(EXIT_ACTION_FAILED, "INDEX_FAILED", f"Monitor {key} did not index.")
        # A rule indexed from a project file starts off; this machine's switch is turned on here.
        patch_graph_json(graph_url(port, f"trigger/{trigger_id}"), {"enabled": True}, on_error=_action_failed)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        shutil.rmtree(monitor_folder, ignore_errors=True)
        raise
    ok({"key": key, "monitor_id": monitor_id, "trigger_id": trigger_id, "process_id": process_id, "cron": cron,
        "folder": str(monitor_folder)})


async def _try_fork_agentic_process(process_id: str, name: str) -> Optional[str]:
    """A headless fork of the session named *name*, made here through the SDK: its id, or None when there is
    no session to fork or its worker cannot fork. The caller decides what None means."""
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.naming.state import SessionNameState, reduce_name  # noqa: PLC0415
    from flow_sdk.migrations.runner import _bootstrap_local  # noqa: PLC0415

    await _bootstrap_local()
    parent = await AgenticProcess.get_by_id(process_id)
    if parent is None or not parent.session_id:
        return None
    try:
        fork = AgenticProcess.fork(
            session_id=parent.session_id,
            workdir=parent.workdir,
            worker_type=parent.worker_type,
            cli_config=parent.cli_config,
            project_id=parent.project_id,
            visible=False,
            # Only asked a question: no terminal, whatever the session runs in.
            pty_mode=False,
            shared_context_entities=list(parent.shared_context_entities or []),
            # Pinned, as a person's rename is: the question it is asked must not rename it.
            name=name,
            auto_rename=False,
            naming_state=reduce_name(SessionNameState(), user_name=name),
        )
    except NotImplementedError:
        return None
    await fork.save()
    return str(fork.id)


async def try_prompt_ap(process_id: str, prompt: str) -> Optional[str]:
    """One turn on the session, run here: the turn's final message, or None when the session is gone or
    the turn did not finish."""
    import uuid  # noqa: PLC0415

    from flow_sdk.builtin.agent_serve import Turn, TurnEngine  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    ap = await AgenticProcess.get_by_id(process_id)
    if ap is None:
        return None
    answer = await TurnEngine().run(Turn(session=str(ap.typeid), key=str(uuid.uuid4()), body=prompt), process=ap)
    return (answer.text or "") if answer.ok else None


class GoalCheck(NamedTuple):
    """What ``try_check_goal`` found."""

    #: The fork that was asked; None when the session could not be forked.
    fork_id: Optional[str]
    #: Its answer; None when there is none, and ``problem`` says why.
    verdict: Optional[MonitorVerdict]
    #: ``"ASK_FAILED"`` (the fork did not answer) or ``"INVALID_ANSWER"`` (no valid answer after the retries).
    problem: Optional[str]


async def delete_check_fork(fork_id: str) -> None:
    """Delete the fork a check asked, row and transcript (``AgenticProcess.delete``): this command made
    it, so nothing else holds it. Left alone, each check would add a session to the user's session list."""
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    fork = await AgenticProcess.get_by_id(fork_id)
    if fork is not None:
        await fork.delete()


async def try_check_goal(process_id: str, goal: str, stop_condition: str, monitor_name: str) -> GoalCheck:
    """Fork the session and ask the fork, here. The fork is deleted once it has answered, or failed to."""
    fork_id = await _try_fork_agentic_process(process_id, f"goal and stop condition check for monitor {monitor_name}")
    if fork_id is None:
        return GoalCheck(fork_id=None, verdict=None, problem=None)
    try:
        prompt = _check_prompt(goal, stop_condition)
        for _attempt in range(1 + _NUDGE_RETRIES):
            reply = await try_prompt_ap(fork_id, prompt)
            if reply is None:
                return GoalCheck(fork_id=fork_id, verdict=None, problem="ASK_FAILED")
            try:
                verdict = MonitorVerdict.from_raw_agent_response(reply)
            except ValidationError as e:
                errors = "; ".join(f"{'.'.join(map(str, err['loc'])) or 'reply'}: {err['msg']}" for err in e.errors())
                prompt = f"Invalid answer, error on {errors}. Reply with only this JSON, nothing else: {_REPLY_FORMAT}"
                continue
            return GoalCheck(fork_id=fork_id, verdict=verdict, problem=None)
        return GoalCheck(fork_id=fork_id, verdict=None, problem="INVALID_ANSWER")
    finally:
        await delete_check_fork(fork_id)


def _prompt_session(port: int, process_id: str, message: str) -> None:
    """Send *message* to the session the way the UI does (its ``prompt`` action). Nothing in the answer is
    read, but the stream is drained: a terminal session's turn is cancelled when its listener hangs up."""
    url = graph_url(port, f"agentic_process/{process_id}/prompt")
    try:
        resp = local_post(url, json={"message": message}, stream=True, timeout=(10, None))
    except requests.exceptions.RequestException as e:
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
    with resp:
        if resp.status_code != 200:
            try:
                body = resp.json()
            except ValueError:
                body = {}
            fail(EXIT_ACTION_FAILED, "PROMPT_REFUSED",
                  str(body.get("message") or f"Session {process_id} did not take the prompt (HTTP {resp.status_code})."))
        for _chunk in resp.iter_content(chunk_size=None):
            pass


def _check_prompt(goal: str, stop_condition: str) -> str:
    return "\n".join((
        f"The goal is: {goal or '(none given)'}. The stop condition is: {stop_condition or '(none given)'}.",
        "Do not continue with your work, only answer.",
        "You are the fork of the original session.",
        "As quickly as you can: is the goal met, is the stop condition met, or should the main process "
        "continue to work?",
        f"Reply with only this JSON: {_REPLY_FORMAT}",
    ))


def _continue_prompt(goal: str, stop_condition: str) -> str:
    return (f"The goal ({goal or 'none given'}) is not met and the stop condition "
            f"({stop_condition or 'none given'}) is not reached. Continue working toward the goal.")


def _self_check_prompt(goal: str, stop_condition: str, key: str) -> str:
    """For a session that cannot fork: it judges for itself, and ends the monitor itself when done."""
    return (f"The goal is: {goal or '(none given)'}. The stop condition is: {stop_condition or '(none given)'}. "
            f"If the goal is met or the stop condition is reached, run `flow process unmonitor {key}` and stop. "
            "Otherwise, continue working toward the goal.")


def log_nudge(document: Path, result: str) -> None:
    """Add this nudge's result to the monitor's ``nudge_log`` (``monitor.json``), keeping the newest."""
    monitor = MonitorSpec.model_validate_json(document.read_text(encoding="utf-8"))
    entry = NudgeLogEntry(at=datetime.now(timezone.utc).isoformat(timespec="seconds"), result=result)
    logged = monitor.model_copy(update={"nudge_log": [*monitor.nudge_log, entry][-MonitorSpec.NUDGE_LOG_LIMIT:]})
    text = json.dumps(logged.model_dump(mode="json", exclude_defaults=True), indent=2)
    atomic_write(document, f"{text}\n".encode("utf-8"))


@process_app.command(
    "monitor-nudge",
    help="Check a monitor now -- what its trigger runs. Skipped while the session is busy.",
)
def nudge_monitor(key: Annotated[str, typer.Argument(help="The monitor key `monitor` printed.")]) -> None:
    try:
        process_id, name = MonitorSpec.split_key(key)
    except ValueError as e:
        fail(EXIT_INVALID_ARG, "BAD_KEY", str(e))
    port = discover_port()
    process, folder, monitor_folder = _process_and_folders(port, process_id, name)
    document = monitor_folder / MonitorSpec.main_file
    if not document.is_file():
        fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No monitor {key}.")
    monitor = MonitorSpec.model_validate_json(document.read_text(encoding="utf-8"))
    goal, stop_condition = monitor.goal, monitor.stop_condition
    if process.get("busy"):
        log_nudge(document, "skipped_busy")
        ok({"key": key, "skipped": "the session is busy"})
        return
    # No lock against a second check: the scheduler runs one instance of a trigger's job at a time
    # (APScheduler's max_instances=1), and the job awaits this command.
    check = run_async(try_check_goal(process_id, goal, stop_condition, name))
    fork_id, verdict, problem = check.fork_id, check.verdict, check.problem
    if fork_id is None:
        log_nudge(document, "self_check")
        _prompt_session(port, process_id, _self_check_prompt(goal, stop_condition, key))
        ok({"key": key, "answer": None, "asked": process_id, "note": "cannot fork: the session checks itself"})
        return
    if verdict is None:
        message = (f"The fork {fork_id} did not answer." if problem == "ASK_FAILED"
                   else f"No valid answer after {_NUDGE_RETRIES} retries; the monitor is unchanged.")
        log_nudge(document, problem or "INVALID_ANSWER")
        fail(EXIT_ACTION_FAILED, problem or "INVALID_ANSWER", message)
    log_nudge(document, verdict.answer)
    if verdict.answer == "continue_to_work":
        _prompt_session(port, process_id, _continue_prompt(goal, stop_condition))
        ok({"key": key, "answer": verdict.answer, "asked": fork_id})
        return
    removed = try_remove_monitor(port, folder, monitor_folder)
    if removed is None:
        fail(EXIT_ACTION_FAILED, "REMOVE_FAILED", f"Monitor {key}'s goal is {verdict.answer}, but it could not be removed.")
    ok({"key": key, "answer": verdict.answer, "asked": fork_id, "removed": removed})


@process_app.command("unmonitor", help="Remove a monitor: the Monitor and its trigger, folders and rows.")
def unmonitor_process(key: Annotated[str, typer.Argument(help="The monitor key `monitor` printed.")]) -> None:
    try:
        process_id, name = MonitorSpec.split_key(key)
    except ValueError as e:
        fail(EXIT_INVALID_ARG, "BAD_KEY", str(e))
    port = discover_port()
    _, folder, monitor_folder = _process_and_folders(port, process_id, name)
    if not (folder.is_dir() or monitor_folder.is_dir()):
        fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No monitor {key}.")
    removed = try_remove_monitor(port, folder, monitor_folder)
    if removed is None:
        fail(EXIT_ACTION_FAILED, "REMOVE_FAILED", f"Monitor {key} could not be removed.")
    ok({"key": key, "removed": removed})

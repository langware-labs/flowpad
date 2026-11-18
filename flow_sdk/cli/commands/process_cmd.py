"""`flow process ...` CLI subgroup — lifecycle control for AgenticProcess.

``flow process restart [--process <id>]``

Restart an agentic-process session (the Claude/Codex worker + its PTY),
preserving the conversation session so the resumed worker continues where it
left off. The headline use case is *self-restart from inside a session* — e.g.
after installing an MCP server the agent runs ``flow process restart`` so the
new MCP config is loaded into a fresh worker. ``--process`` defaults to the
current process via ``FLOWPAD_EXECUTION_SCOPE``.

The command targets the backend ``self-restart`` action, which schedules the
restart on the server and returns immediately. That detachment matters: this
CLI process is a child of the worker the restart kills, so an inline restart
would sever the request mid-flight. Because the server owns the work, the
restart completes regardless, and the frontend terminal re-attaches to the new
PTY via the ``worker.restarted`` entity event the action emits.

``flow process start "<prompt>"``

Run one headless turn IN THIS PROCESS and stream what the agent writes: no
server, no login. Funding is whatever the box resolves — on a machine that has
never signed in to anything, a PUBLIC hub endpoint bound with
``flow llm user use <endpoint-id>``. The process id goes to stderr, the
agent's messages to stdout (whole messages: a transcript records messages, not
tokens), and the exit code is the turn's ``ExitCode``. With no ``--worker``
the selected harness runs when its CLI is installed, else the builtin
``deepagents`` worker, which ships with the wheel — so a box with only
flow_sdk installed answers with no flags at all.

``flow process schedule "<prompt>" --at <ISO time> | --in <2h>``

Set a one-time callback into THIS session: at that time the session is started if it is stopped
and, once idle, receives the prompt. ``flow process schedules`` lists the ones still waiting;
``flow process unschedule <id>`` removes one. With ``--every 10m`` it repeats, ending by itself.

``flow process monitor --name <n> --goal "<g>" --cron "*/10 * * * *"``

Watch a session's goal: a trigger asset in its project runs ``flow process monitor-nudge <key>``, which
asks a fork of the session whether the goal is met and prompts the session to continue until it is.
``flow process unmonitor <key>`` removes it (docs/automations.md, "A monitor on a session's goal").

``flow process`` is the home for future lifecycle siblings (``stop``,
``status``).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Iterator, Literal, Optional

import requests
import typer
from pydantic import BaseModel, ConfigDict, ValidationError
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    EXIT_CONNECTION_ERROR,
    EXIT_INVALID_ARG,
    quiet_logs,
    run_async,
    safe_echo,
)
from flow_sdk.cli.commands._common import (
    bad_response_message as _bad_response_message,
)
from flow_sdk.cli.commands._common import (
    delete_graph_json as _delete_graph_json,
)
from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    get_graph_json as _get_graph_json,
)
from flow_sdk.cli.commands._common import (
    graph_url as _graph_url,
)
from flow_sdk.cli.commands._common import (
    local_post as _local_post,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)
from flow_sdk.cli.commands._common import (
    patch_graph_json as _patch_graph_json,
)
from flow_sdk.cli.commands._common import (
    post_graph_json as _post_graph_json,
)
from flow_sdk.cli.commands._common import (
    resolve_process_id as _resolve_process_id,
)
from flow_sdk.core.headless_turn import HeadlessTurnRequest, headless_turn

process_app = typer.Typer(
    name="process",
    help="Lifecycle control for AgenticProcess sessions (restart, …).",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_ACTION_FAILED = 7


@process_app.command(
    "restart",
    help=(
        "Restart an agentic-process session (kills the worker + PTY, then "
        "re-spawns it, resuming the same session). Defaults to the current "
        "process (FLOWPAD_EXECUTION_SCOPE). Run this after installing an MCP "
        "server so the new config is picked up. The restart is scheduled "
        "server-side and returns immediately; this command (and the worker it "
        "runs in) is then replaced."
    ),
)
def restart_process(
    process: Annotated[
        Optional[str],
        typer.Option(
            "--process",
            "-p",
            help="AgenticProcess id or TypeId. Defaults to FLOWPAD_EXECUTION_SCOPE.",
        ),
    ] = None,
) -> None:
    process_id = _resolve_process_id(process)
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process/{process_id}/self-restart"

    try:
        resp = _local_post(url, json={}, timeout=15)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
        return

    if resp.status_code != 200 or body.get("status") != "SUCCESS":
        _fail(
            EXIT_ACTION_FAILED,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {resp.status_code}"),
        )
        return

    data = body.get("data") or {}
    _ok(
        {
            "process_id": process_id,
            "scheduled": bool(data.get("scheduled", True)),
            "note": "Restart scheduled. If this is a self-restart, the session is being replaced now.",
            **{k: v for k, v in data.items() if k != "scheduled"},
        }
    )


@process_app.command(
    "start",
    help=(
        "Run one headless turn and stream the agent's messages. Runs inside the instance's backend "
        "when one is up, else here with no server. Funded by whatever this box resolves — e.g. a "
        "public hub endpoint bound with `flow llm user use <endpoint-id>`. Exit code is the turn's "
        "(0 = answered)."
    ),
)
def start_process(
    prompt: Annotated[str, typer.Argument(help="What to ask the agent.")],
    worker: Annotated[
        Optional[str],
        typer.Option(
            "--worker",
            "-w",
            help="Harness to run (claude, codex, deepagents, …). Default: the selected one if installed, else deepagents.",
        ),
    ] = None,
    model: Annotated[
        Optional[str], typer.Option("--model", "-m", help="Model slug. Default: what the funding source resolves.")
    ] = None,
    workdir: Annotated[
        Optional[str], typer.Option("--workdir", help="Where the agent works. Default: a fresh temp directory.")
    ] = None,
    llm: Annotated[
        Optional[str],
        typer.Option(
            "--llm",
            help="Source that funds this run only: a `flow llm list` number, endpoint id or name prefix. "
            "Pins the process, never the box default.",
        ),
    ] = None,
) -> None:
    worker_type = None
    if worker:
        from flow_sdk.flowpad_types.vendors import vendor_or_none  # noqa: PLC0415

        vendor = vendor_or_none(worker)
        if vendor is None:
            _fail(EXIT_INVALID_ARG, "UNKNOWN_WORKER", f"No worker named {worker!r}.")
        worker_type = vendor.worker_type
    endpoint_typeid = None
    if llm:
        from flow_sdk.cli.commands.llm_cmd import _pick, _rows, _status  # noqa: PLC0415

        endpoint_typeid = _pick(_rows(_status()), llm).typeid
    port = _discover_port(required=False)
    request = HeadlessTurnRequest(prompt=prompt, worker=worker_type, model=model, workdir=workdir, llm=endpoint_typeid)
    if port is not None:
        raise typer.Exit(_run_on_server(port, request))
    # ERROR too: a turn that fails says why through its own verdict, so the log would only repeat it.
    quiet_logs(logging.ERROR)
    raise typer.Exit(run_async(_run_start(request)))


_IN_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _run_time(at: Optional[str], in_: Optional[str]) -> str:
    """``--at`` / ``--in`` as one ISO time with its offset (a bare ``--at`` is this machine's local time)."""
    from datetime import datetime, timedelta  # noqa: PLC0415

    if bool(at) == bool(in_):
        _fail(EXIT_INVALID_ARG, "BAD_TIME", "Give exactly one of --at <ISO time> or --in <30m|2h|3d>.")
    try:
        if in_:
            when = datetime.now().astimezone() + timedelta(seconds=float(in_[:-1]) * _IN_UNITS[in_[-1].lower()])
        else:
            when = datetime.fromisoformat(at).astimezone()
    except (ValueError, KeyError, IndexError):
        _fail(EXIT_INVALID_ARG, "BAD_TIME", f"Cannot read the time {at or in_!r}. Use --at 2026-01-31T09:00 or --in 2h.")
    return when.isoformat(timespec="seconds")


def _action_failed(status_code: int, body: dict) -> None:
    _fail(EXIT_ACTION_FAILED, str(body.get("error_code") or "ACTION_FAILED"),
          str(body.get("message") or body.get("error") or f"HTTP {status_code}"))


def _seconds(value: str, flag: str) -> float:
    try:
        return float(value[:-1]) * _IN_UNITS[value[-1].lower()]
    except (ValueError, KeyError, IndexError):
        _fail(EXIT_INVALID_ARG, "BAD_TIME", f"Cannot read {flag} {value!r}. Use 30s, 10m, 2h or 3d.")
        raise


# ── monitor: a goal watched on a clock ──────────────────────────────────────
#
# ``monitor`` writes a trigger ASSET into the process's project; the trigger runs ``monitor-nudge``,
# which asks a fork of the session whether the goal is met, and either prompts the session to go on
# or ends the monitor. ``unmonitor`` removes it. The asset is keyed ``<process id>_monitor_<name>``.

EXIT_NOT_FOUND = 4
_MONITOR_SEP = "_monitor_"
_MONITOR_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")
_NUDGE_RETRIES = 3
#: A nudge older than this is taken to have died, and its lock is taken over.
_NUDGE_LOCK_STALE_S = 15 * 60
_REPLY_FORMAT = '{"answer": "goal_met" | "stop_condition_reached" | "continue_to_work"}'


class MonitorVerdict(BaseModel):
    """What the asked session must answer -- nothing more, nothing else."""

    model_config = ConfigDict(extra="forbid")

    answer: Literal["goal_met", "stop_condition_reached", "continue_to_work"]


def _monitor_key(process_id: str, name: str) -> str:
    return f"{process_id}{_MONITOR_SEP}{name}"


def _split_monitor_key(key: str) -> tuple[str, str]:
    process_id, sep, name = key.partition(_MONITOR_SEP)
    if not (sep and process_id and _MONITOR_NAME.fullmatch(name)):
        _fail(EXIT_INVALID_ARG, "BAD_KEY", f"{key!r} is not a monitor key (<process id>{_MONITOR_SEP}<name>).")
    return process_id, name


def _not_found(what: str):
    def on_error(status_code: int, body: dict) -> None:
        if status_code == 404:
            _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No {what}.")
        _action_failed(status_code, body)

    return on_error


def _process_and_folder(port: int, process_id: str, name: str) -> tuple[dict, Path]:
    """The session, and its monitor's folder under its project (which may not exist yet)."""
    process = _get_graph_json(_graph_url(port, f"agentic_process/{process_id}"),
                              on_error=_not_found(f"session {process_id}"))
    if not process:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No session {process_id}.")
    project_id = process.get("project_id")
    project = _get_graph_json(_graph_url(port, f"project/{project_id}"),
                              on_error=_not_found(f"project {project_id}")) if project_id else None
    mount = (project or {}).get("fs_storage_mount_path")
    if not mount:
        _fail(EXIT_ACTION_FAILED, "NO_PROJECT_FOLDER",
              f"Session {process_id} has no project folder to keep a monitor in.")
    return process, Path(mount) / "agentic-assets" / "trigger" / _monitor_key(process_id, name)


def _index_monitor(port: int, folder: Path) -> str:
    """Index the monitor's folder (which arms it); the trigger's id. Re-indexing an unchanged folder
    answers the same id, so this is also how ``unmonitor`` finds the row."""
    data = _post_graph_json(_graph_url(port, "compute_node/@local/fs-records/index"), None,
                            params={"type": "trigger", "path": str(folder.resolve())}, timeout=120,
                            on_error=_action_failed)
    typeid = next(iter(data.get("typeids") or []), "")
    if not typeid:
        _fail(EXIT_ACTION_FAILED, "INDEX_FAILED", f"The monitor at {folder} did not index.")
    return typeid.removeprefix("trigger-")


def _remove_monitor(port: int, folder: Path) -> str:
    """Folder first, then the row: a row whose folder is still on disk comes back with the next index."""
    trigger_id = _index_monitor(port, folder)
    shutil.rmtree(folder)
    _delete_graph_json(_graph_url(port, f"trigger/{trigger_id}"), on_error=_action_failed)
    return trigger_id


@process_app.command(
    "monitor",
    help=(
        "Watch a session's goal: on a cron mask (--cron '*/10 * * * *'), a fork of the session is asked "
        "whether the goal is met or the stop condition reached. Not yet: the session is prompted to continue. Met or reached: the "
        "monitor ends, quietly. Kept as a trigger in the session's project; `unmonitor <key>` removes it."
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
    if not _MONITOR_NAME.fullmatch(name):
        _fail(EXIT_INVALID_ARG, "BAD_NAME", f"{name!r} cannot name a monitor: use up to 40 letters, digits, '-' or '_'.")
    goal, stop_condition = (goal or "").strip(), (stop_condition or "").strip()
    if not (goal or stop_condition):
        _fail(EXIT_INVALID_ARG, "MISSING_GOAL", "Give --goal, --stop-condition, or both.")
    from apscheduler.triggers.cron import CronTrigger  # noqa: PLC0415

    try:
        CronTrigger.from_crontab(cron)
    except ValueError as e:
        _fail(EXIT_INVALID_ARG, "BAD_CRON", f"Cannot read the cron mask {cron!r}: {e}")

    from flow_sdk.schema.data_spec.trigger_spec import ScheduleTriggerSpec, ThenSpec, TriggerSpec  # noqa: PLC0415

    process_id = _resolve_process_id(process)
    port = _discover_port()
    _, folder = _process_and_folder(port, process_id, name)
    if folder.exists():
        _fail(EXIT_INVALID_ARG, "ALREADY_MONITORED",
              f"Session {process_id} already has a monitor named {name!r}; `unmonitor` it first.")
    key = _monitor_key(process_id, name)
    spec = TriggerSpec(
        name=f"Monitor {name}",
        description=goal or stop_condition,
        # One machine's session: nothing to offer a clone of the project.
        recommended=False,
        schedule=ScheduleTriggerSpec(every="cron", expr=cron),
        then=ThenSpec(run_script=f"flow process monitor-nudge {key}"),
    )
    folder.mkdir(parents=True)
    (folder / "trigger.json").write_text(
        json.dumps(spec.model_dump(mode="json", exclude_defaults=True, by_alias=True), indent=2) + "\n",
        encoding="utf-8",
    )
    (folder / "monitor.json").write_text(json.dumps({
        "process_id": process_id, "name": name, "goal": goal, "stop_condition": stop_condition,
        "cron": cron,
    }, indent=2) + "\n", encoding="utf-8")
    try:
        trigger_id = _index_monitor(port, folder)
        # A rule indexed from a project file starts off; this machine's switch is turned on here.
        _patch_graph_json(_graph_url(port, f"trigger/{trigger_id}"), {"enabled": True}, on_error=_action_failed)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    _ok({"key": key, "trigger_id": trigger_id, "process_id": process_id, "cron": cron, "folder": str(folder)})


def _state_dir() -> Path:
    """This machine's nudge bookkeeping -- never in the project folder, which travels."""
    return Path(tempfile.gettempdir()) / "flowpad-monitor"


@contextlib.contextmanager
def _nudge_lock(key: str) -> Iterator[bool]:
    """True when this nudge is the only one running for ``key``."""
    path = _state_dir() / f"{key}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(FileNotFoundError):
        if time.time() - path.stat().st_mtime > _NUDGE_LOCK_STALE_S:
            path.unlink()
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        yield False
        return
    try:
        yield True
    finally:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


async def _fork(process_id: str) -> Optional[str]:
    """A headless fork of the session, made here through the SDK; None when its worker cannot fork."""
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.migrations.runner import _bootstrap_local  # noqa: PLC0415

    await _bootstrap_local()
    parent = await AgenticProcess.get_by_id(process_id)
    if parent is None:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No session {process_id}.")
    if not parent.session_id:
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
            name=None,
        )
    except NotImplementedError:
        return None
    await fork.save()
    return str(fork.id)


async def _ask(process_id: str, prompt: str) -> str:
    """One turn on the session, run here; the turn's final message."""
    import uuid  # noqa: PLC0415

    from flow_sdk.builtin.agent_serve import Turn, TurnEngine  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    ap = await AgenticProcess.get_by_id(process_id)
    if ap is None:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No session {process_id}.")
    answer = await TurnEngine().run(Turn(session=str(ap.typeid), key=str(uuid.uuid4()), body=prompt), process=ap)
    if not answer.ok:
        _fail(EXIT_ACTION_FAILED, "ASK_FAILED", answer.detail or f"Session {process_id} did not answer.")
    return answer.text or ""


def _verdict(reply: str) -> MonitorVerdict:
    """The reply as a ``MonitorVerdict``: its JSON object, even inside a ``` fence or a sentence."""
    text = reply.strip()
    start, end = text.find("{"), text.rfind("}")
    return MonitorVerdict.model_validate_json(text[start:end + 1] if 0 <= start < end else text)


async def _check(process_id: str, goal: str, stop_condition: str) -> tuple[Optional[str], Optional[MonitorVerdict]]:
    """Fork the session and ask the fork, here; ``(fork id, verdict)``. No fork: ``(None, None)``.
    No valid answer after the retries: ``(fork id, None)``."""
    fork_id = await _fork(process_id)
    if fork_id is None:
        return None, None
    prompt = _check_prompt(goal, stop_condition)
    for _attempt in range(1 + _NUDGE_RETRIES):
        reply = await _ask(fork_id, prompt)
        try:
            return fork_id, _verdict(reply)
        except ValidationError as e:
            errors = "; ".join(f"{'.'.join(map(str, err['loc'])) or 'reply'}: {err['msg']}" for err in e.errors())
            prompt = f"Invalid answer, error on {errors}. Reply with only this JSON, nothing else: {_REPLY_FORMAT}"
    return fork_id, None


def _prompt_session(port: int, process_id: str, message: str) -> None:
    """Send *message* to the session the way the UI does (its ``prompt`` action). Nothing in the answer is
    read, but the stream is drained: a terminal session's turn is cancelled when its listener hangs up."""
    url = _graph_url(port, f"agentic_process/{process_id}/prompt")
    try:
        resp = _local_post(url, json={"message": message}, stream=True, timeout=(10, None))
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
    with resp:
        if resp.status_code != 200:
            try:
                body = resp.json()
            except ValueError:
                body = {}
            _fail(EXIT_ACTION_FAILED, "PROMPT_REFUSED",
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


@process_app.command(
    "monitor-nudge",
    help="Check a monitor now -- what its trigger runs. Skipped while the session is busy or another check runs.",
)
def nudge_monitor(key: Annotated[str, typer.Argument(help="The monitor key `monitor` printed.")]) -> None:
    process_id, name = _split_monitor_key(key)
    port = _discover_port()
    process, folder = _process_and_folder(port, process_id, name)
    if not (folder / "monitor.json").is_file():
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No monitor {key}.")
    monitor = json.loads((folder / "monitor.json").read_text(encoding="utf-8"))
    goal, stop_condition = str(monitor.get("goal") or ""), str(monitor.get("stop_condition") or "")
    if process.get("busy"):
        _ok({"key": key, "skipped": "the session is busy"})
        return
    with _nudge_lock(key) as only:
        if not only:
            _ok({"key": key, "skipped": "another check is running"})
            return
        fork_id, verdict = run_async(_check(process_id, goal, stop_condition))
        if fork_id is None:
            _prompt_session(port, process_id, _self_check_prompt(goal, stop_condition, key))
            _ok({"key": key, "answer": None, "asked": process_id, "note": "cannot fork: the session checks itself"})
            return
        if verdict is None:
            _fail(EXIT_ACTION_FAILED, "INVALID_ANSWER",
                  f"No valid answer after {_NUDGE_RETRIES} retries; the monitor is unchanged.")
        if verdict.answer == "continue_to_work":
            _prompt_session(port, process_id, _continue_prompt(goal, stop_condition))
            _ok({"key": key, "answer": verdict.answer, "asked": fork_id})
            return
        trigger_id = _remove_monitor(port, folder)
        _ok({"key": key, "answer": verdict.answer, "asked": fork_id, "removed": trigger_id})


@process_app.command("unmonitor", help="Remove a monitor: its trigger and its folder in the project.")
def unmonitor_process(key: Annotated[str, typer.Argument(help="The monitor key `monitor` printed.")]) -> None:
    process_id, name = _split_monitor_key(key)
    port = _discover_port()
    _, folder = _process_and_folder(port, process_id, name)
    if not folder.is_dir():
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No monitor {key}.")
    _ok({"key": key, "removed": _remove_monitor(port, folder)})


@process_app.command(
    "schedule",
    help=(
        "Set a callback into this session: once (--at / --in), or repeating (--every 10m, ending after --times N "
        "runs or at --for 8h / --until <ISO>; default --for 1d). Each time, the session is started if stopped and, "
        "once idle, receives PROMPT. A repeating one is ONE automation that counts its runs and ends by itself — "
        "never schedule it again from inside a callback. Write PROMPT so it stands on its own."
    ),
)
def schedule_prompt(
    prompt: Annotated[str, typer.Argument(help="What the session should do or check at that time.")],
    at: Annotated[Optional[str], typer.Option("--at", help="When, ISO: 2026-01-31T09:00 (local time unless it has an offset).")] = None,
    in_: Annotated[Optional[str], typer.Option("--in", help="How long from now: 30m, 2h, 3d.")] = None,
    every: Annotated[Optional[str], typer.Option("--every", help="Repeat every 30s, 10m, 2h, 1d.")] = None,
    times: Annotated[Optional[int], typer.Option("--times", help="With --every: end after this many runs.")] = None,
    for_: Annotated[Optional[str], typer.Option("--for", help="With --every: end after this long (8h). Default 1d.")] = None,
    until: Annotated[Optional[str], typer.Option("--until", help="With --every: end at this ISO time.")] = None,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help="Defaults to the current session.")] = None,
) -> None:
    from datetime import datetime, timedelta  # noqa: PLC0415

    process_id = _resolve_process_id(process)
    action = {"action_type": "prompt_process", "target_type_id": f"agentic_process-{process_id}", "prompt": prompt}
    body: dict = {"name": " ".join(prompt.split())[:60], "trigger_type": "schedule", "actions": [action]}
    if every:
        if at or in_:
            _fail(EXIT_INVALID_ARG, "BAD_TIME", "Give --every, or --at / --in — not both.")
        _seconds(every, "--every")
        ends = until or (None if times and not for_ else
                         (datetime.now().astimezone() + timedelta(seconds=_seconds(for_ or "1d", "--for"))).isoformat(timespec="seconds"))
        body.update(sched_trigger_type="interval", expr=every.strip().lower())
        if times:
            body["max_runs"] = times
        if ends:
            body["expires_at"] = datetime.fromisoformat(ends).astimezone().isoformat()
    else:
        if times or for_ or until:
            _fail(EXIT_INVALID_ARG, "BAD_TIME", "--times / --for / --until go with --every.")
        body.update(sched_trigger_type="date", expr=_run_time(at, in_))
    port = _discover_port()
    same = [s for s in _get_graph_json(_graph_url(port, f"agentic_process/{process_id}/scheduled-prompts"),
                                       on_error=_action_failed) or []
            if every and s.get("prompt") == prompt and s.get("every")]
    if same:  # already repeating: the same automation, not a second one
        _ok({"trigger_id": same[0]["id"], "already_scheduled": True, **{k: same[0].get(k) for k in ("every", "runs", "max_runs", "until", "status")}})
        return
    data = _post_graph_json(_graph_url(port, "trigger"), body, on_error=_action_failed)
    _ok({"trigger_id": data.get("id"), "process_id": process_id,
         **({"every": every, "max_runs": times, "until": body.get("expires_at")} if every else {"at": body["expr"]})})


@process_app.command("schedules", help="The callbacks this session has waiting or repeating: status, runs, next, end.")
def list_scheduled(
    process: Annotated[Optional[str], typer.Option("--process", "-p", help="Defaults to the current session.")] = None,
) -> None:
    process_id = _resolve_process_id(process)
    url = _graph_url(_discover_port(), f"agentic_process/{process_id}/scheduled-prompts")
    _ok({"process_id": process_id, "scheduled": _get_graph_json(url, on_error=_action_failed)})


@process_app.command("unschedule", help="End a callback now (its runs stay in Automations).")
def unschedule_prompt(trigger_id: Annotated[str, typer.Argument(help="The trigger id `schedule` printed.")]) -> None:
    data = _post_graph_json(_graph_url(_discover_port(), f"trigger/{trigger_id}/cancel"), {}, on_error=_action_failed)
    _ok({"trigger_id": trigger_id, "status": (data or {}).get("status", "cancelled")})


class _Printer:
    """Prints a turn's events as ``flow process start`` always has -- the process id and tool steps on
    stderr, the agent's words on stdout -- and keeps the turn's exit code: 1 until a ``done`` arrives."""

    def __init__(self) -> None:
        self.exit_code: int | None = None

    def feed(self, event: dict) -> None:
        kind = event.get("kind")
        if kind == "process":
            safe_echo(f"running agentic process {event.get('id')}…", err=True)
        elif kind == "tool":
            safe_echo(f"· {event.get('name')}", err=True)
        elif kind == "text":
            safe_echo(event.get("text") or "")
        elif kind == "done":
            if event.get("text"):
                safe_echo(event["text"])
            if not event.get("ok"):
                safe_echo(event.get("detail") or "The turn did not finish.", err=True)
            self.exit_code = int(event.get("exit_code") or 0)

    def result(self) -> int:
        if self.exit_code is None:
            safe_echo("The turn ended before it reported a result.", err=True)
            return 1
        return self.exit_code


def _run_on_server(port: int, request: HeadlessTurnRequest) -> int:
    """The turn, run by the live backend (one SQLite writer) and streamed back as NDJSON."""
    url = f"http://127.0.0.1:{port}/api/v1/agentic_process/headless-turn"
    try:
        resp = _local_post(url, json=request.model_dump(), stream=True, timeout=(10, None))
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return 1
    if resp.status_code != 200:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
        return 1
    printer = _Printer()
    for line in resp.iter_lines(decode_unicode=True):
        if line:
            printer.feed(json.loads(line))
    return printer.result()


async def _run_start(request: HeadlessTurnRequest) -> int:
    """One turn in THIS process (no backend up), printed as it streams."""
    from flow_sdk.migrations.runner import _bootstrap_local  # noqa: PLC0415

    await _bootstrap_local()
    printer = _Printer()
    async for event in headless_turn(request):
        printer.feed(event)
    return printer.result()

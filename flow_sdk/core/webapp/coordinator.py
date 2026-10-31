"""THE way a web app comes up and recovers on this machine, whoever asks — a screen opening it, its page
reporting an error, ``flow app open``, an agent's auto-open, a person pressing Fix it.

One run per app at a time (a second caller joins it and reads the record). A run:

1. **Warm.** The record says up and ``readiness.quick`` agrees: done, nothing else is asked.
2. **Setup.** What the app stands on — its declared ``asset_setup`` nodes (a dependency such as another app's
   service), credentials — is checked rooted at the app; only when something is owed does the setup run go
   (its tree, questions and progress are the setup run's, ``setup_run`` on the record).
3. **Up.** ``webapp_setup``'s ``up`` step: install → build → start → present, each only when its own check
   fails. It writes its states and, on failure, the typed failure into the record.
4. **Recovery ladder** for that failure, bounded per fingerprint and persisted in the record:
   learned handling (code) → one deterministic action (code) → the fixer agent, once per fingerprint per
   ``AGENT_COOLDOWN`` (a person's Fix it may run it again) → ``needs_person``.

The page's own errors (``report_page``) enter at step 4. Nothing here remembers a verdict in memory: the record
is the state, a backend restart reads it back, and an agent call that died with the backend is not replayed.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from flow_sdk.core.webapp import handling as handlings
from flow_sdk.core.webapp import record
from flow_sdk.core.webapp.failure import make, of_page, of_step
from flow_sdk.schema.data_spec.webapp_lifecycle_spec import (
    AGENT_COOLDOWN,
    BUSY,
    FailureCode,
    FailurePhase,
    HandlingAction,
    LifecycleState,
    WebappFailureSpec,
    WebappFixRequest,
    WebappHandlingSpec,
    WebappLifecycleSpec,
)

logger = logging.getLogger(__name__)

Reason = Literal["open", "page", "probe", "restart", "fix", "cli"]

#: The run going for each app (by bare id). One at a time; a second caller joins it.
_TASKS: dict[str, asyncio.Task] = {}

#: A handling that ran this many times for one fingerprint without holding is not run again: the ladder moves on.
HANDLING_TRIES = 2
#: A failure that turns into another one is followed this deep, then the last one is the answer.
MAX_CHAIN = 3

#: What code does, with no handling and no agent, for a failure it knows — once per fingerprint.
_DETERMINISTIC: dict[FailureCode, HandlingAction] = {
    FailureCode.EXITED: HandlingAction.RESTART,
    FailureCode.HEALTH_NO_ANSWER: HandlingAction.RESTART,
    FailureCode.PORT_NEVER_OPENED: HandlingAction.RESTART,
    FailureCode.NOT_ANSWERING: HandlingAction.RESTART,
    FailureCode.WRONG_PORT: HandlingAction.FREE_PORTS,
    FailureCode.OUT_OF_MEMORY: HandlingAction.NEEDS_PERSON,
    FailureCode.FOLDER_GONE: HandlingAction.NEEDS_PERSON,
    FailureCode.PORT_CONFLICT: HandlingAction.NEEDS_PERSON,
}


def _bare(webapp_id: str) -> str:
    return str(webapp_id).removeprefix("micro_app-")


async def _app(webapp_id: str):
    from flow_sdk.builtin.webapp_setup import _app as fresh  # noqa: PLC0415

    return await fresh(_bare(webapp_id))


async def _project(app):
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    return await Project.get_by_id(app.project_id) if getattr(app, "project_id", None) else None


def running(webapp_id: str) -> bool:
    task = _TASKS.get(_bare(webapp_id))
    return task is not None and not task.done()


async def bring_up(app: Any, *, display: str = "", reason: Reason = "open", wait: bool = False,
                   failure: Optional[WebappFailureSpec] = None) -> WebappLifecycleSpec:
    """Bring ``app`` up (see module doc) and answer its record — at once, or, ``wait``, once the run settled.
    ``failure``: a failure already seen (a page report): the run starts at the ladder."""
    key = _bare(app.id)
    project_id = str(app.project_id or "")
    rec = record.read(key, project_id)
    if reason in ("open", "cli") and failure is None and not running(key):
        from flow_sdk.core.webapp import readiness  # noqa: PLC0415

        if await readiness.quick(app, rec):
            return rec
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415

    if failure is None and not webapp_setup._processes(app) and not running(key):
        # Files Flowpad serves itself: placing them is the whole of it — done here, at once, no run (B9).
        found = await _up(app, display=display)
        if found is not None:
            await _ladder(app, found, display=display, reason=reason)
        return record.read(key, project_id)
    task = _TASKS.get(key)
    if task is None or task.done():
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

        # Claimed before any await: a second caller arriving meanwhile joins this run, never starts its own.
        task = _TASKS[key] = create_detached_task(_run(key, display=display, reason=reason, failure=failure),
                                                  name=f"webapp-up:{key}")
    if wait:
        await asyncio.gather(task, return_exceptions=True)
    return record.read(key, project_id)


async def _run(key: str, *, display: str, reason: Reason, failure: Optional[WebappFailureSpec]) -> None:
    try:
        if record.read(key).state not in BUSY:
            await record.set_state(key, LifecycleState.STARTING, "checking what it needs")
        app = await _app(key)
        if app is None or not app.asset_ref:
            await record.set_state(key, LifecycleState.FAILED, "there is no such web app here",
                                   failure=make(FailurePhase.SETUP, FailureCode.FOLDER_GONE, "no such web app"))
            return
        if failure is None:
            failure = await _setup_and_up(app, display=display)
        if failure is not None:
            await _ladder(app, failure, display=display, reason=reason)
    except asyncio.CancelledError:
        await record.set_state(key, LifecycleState.FAILED, "stopped")
        raise
    except Exception as exc:  # noqa: BLE001 — a run that broke says so on the record, never vanishes
        logger.exception("web app %s: bring-up failed", key)
        await record.set_state(key, LifecycleState.FAILED, f"bring-up failed: {exc}",
                               failure=make(FailurePhase.SETUP, FailureCode.UNKNOWN, str(exc)))


async def _setup_and_up(app, *, display: str) -> Optional[WebappFailureSpec]:
    """Steps 2-3. None when the app is up; else the failure the ladder starts from."""
    owed = await _setup_owed(app, display=display)
    if owed is not None:
        return owed
    return await _up(app, display=display)


async def _up(app, *, display: str = "") -> Optional[WebappFailureSpec]:
    """The ``up`` step; None when it held, else its typed failure (also on the record)."""
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415

    answer = await webapp_setup.step(str(app.id), webapp_setup.UP, check=False, display=display)
    if answer.ok:
        rec = record.read(str(app.id))
        if rec.state is not LifecycleState.UP:  # a static app: nothing ran, so nothing wrote UP
            await webapp_setup._record_up(str(app.id), app, str(app.project_id or ""), answer)
        return None
    return of_step(answer.value) or record.read(str(app.id)).failure or make(
        FailurePhase.SETUP, FailureCode.UNKNOWN, answer.detail, folder=app.asset_ref)


async def _setup_owed(app, *, display: str) -> Optional[WebappFailureSpec]:
    """Run what the app stands on when its check finds it owed. None when nothing is (or the run made it so)."""
    from flow_sdk.builtin.project_setup import _RUNS, setup_run_address, start_setup  # noqa: PLC0415
    from flow_sdk.core.setup.derive import ProjectTree  # noqa: PLC0415
    from flow_sdk.core.setup.execute import execute_setup  # noqa: PLC0415
    from flow_sdk.core.setup.load import _leaf_failure, _unmet  # noqa: PLC0415

    project = await _project(app)
    if project is None:
        return None
    target = str(app.typeid)
    tree = await ProjectTree(project, display=display, connect_here=False).load()
    node = await tree.resolve_node(target)
    if node is None or not node.children:
        return None  # nothing declared under the app: no setup walk at all
    checked = await execute_setup(target, resolve_node=tree.resolve_node, resolve_op=tree.resolve_op,
                                  subject_entity=f"project-{project.id}", check_only=True, approved=True,
                                  cwd=getattr(project, "fs_storage_mount_path", None))
    if checked.ok or not _unmet(checked, target):
        return None
    run = await start_setup(project, root=target, tree=tree, load_after=False, connect_here=False)
    await record.set_state(str(app.id), LifecycleState.STARTING,
                           f"setting up what it needs: {_leaf_failure(checked.root, owed=True) or 'its setup'}",
                           setup_owed=_leaf_failure(checked.root, owed=True) or "", )
    task = _RUNS.get((str(project.id), target))
    result = await asyncio.shield(task) if task is not None else None
    if result is not None and result.ok and not _unmet(result, target):
        await record.change(str(app.id), setup_owed="")
        return None
    why = (_unmet(result, target) if result is not None else "") or _leaf_failure(checked.root, owed=True)
    logger.info("web app %s: setup still owes %s (%s)", app.name, why, run)
    return make(FailurePhase.DEPENDENCY, FailureCode.SETUP_OWED, why or "its setup is not done", folder=app.asset_ref)


# ── the ladder ────────────────────────────────────────────────────────────────


async def _ladder(app, failure: WebappFailureSpec, *, display: str, reason: Reason, depth: int = 0) -> None:
    key = str(app.id)
    folder = app.asset_ref
    tried: list[str] = []
    try:
        own = await asyncio.to_thread(handlings.load, folder)
    except handlings.HandlingFileError as exc:
        bad = make(FailurePhase.SETUP, FailureCode.BAD_HANDLINGS, str(exc), folder=folder)
        await record.set_state(key, LifecycleState.NEEDS_PERSON, str(exc), failure=bad, recovery="")
        return
    found = handlings.match(failure, own)
    rec = record.read(key)
    counter = rec.counter(failure.fingerprint)

    if found is not None and found.action is HandlingAction.NEEDS_PERSON:
        await _needs_person(key, failure, found.arg or found.note or failure.raw or failure.text, found)
        return
    if found is not None and found.action is HandlingAction.IGNORE:
        handlings.log(folder, failure, "ignore", "fixed", found.id)
        if failure.phase is FailurePhase.PAGE:
            await record.set_state(key, LifecycleState.UP, "up", failure=None, recovery="")
        return
    hint = found.arg if found is not None and found.action is HandlingAction.ESCALATE else ""

    # 1. A learned handling, by code.
    if found is not None and found.action is not HandlingAction.ESCALATE and counter.handled < HANDLING_TRIES:
        outcome = await _act(app, failure, found.action, found.arg, label=f"handling {found.id}", display=display,
                             counts={"handled": 1})
        handlings.count(folder, found.id, fixed=outcome is None)
        handlings.log(folder, failure, found.action.value, "fixed" if outcome is None else "not_fixed", found.id)
        if outcome is None:
            return
        tried.append(f"handling {found.id} ({found.action.value}): did not hold")
        if outcome.fingerprint != failure.fingerprint and depth < MAX_CHAIN:
            await _ladder(app, outcome, display=display, reason=reason, depth=depth + 1)
            return
        failure = outcome

    # 2. One deterministic action, by its code.
    action = _DETERMINISTIC.get(failure.code)
    if found is None and action is HandlingAction.NEEDS_PERSON:
        await _needs_person(key, failure, failure.raw or failure.text)
        return
    if found is None and action is not None and record.read(key).counter(failure.fingerprint).deterministic == 0:
        outcome = await _act(app, failure, action, "", label=action.value, display=display, counts={"deterministic": 1})
        handlings.log(folder, failure, action.value, "fixed" if outcome is None else "not_fixed")
        if outcome is None:
            return
        tried.append(f"{action.value}: did not hold")
        if outcome.fingerprint != failure.fingerprint and depth < MAX_CHAIN:
            await _ladder(app, outcome, display=display, reason=reason, depth=depth + 1)
            return
        failure = outcome

    # 3. The fixer agent, once per fingerprint per cooldown (a person's Fix it may run it again).
    counter = record.read(key).counter(failure.fingerprint)
    if _agent_allowed(counter, reason):
        outcome = await _agent(app, failure, hint=hint, tried=tried, display=display)
        handlings.log(folder, failure, "agent", "fixed" if outcome is None else "not_fixed")
        if outcome is None:
            return
        failure = outcome
        tried.append("the fixer agent: did not hold")
    # 4. A person.
    await _needs_person(key, failure, failure.raw or failure.text, tried=tried)


def _agent_allowed(counter, reason: Reason) -> bool:
    if reason == "fix":
        return True
    if counter.agent == 0:
        return True
    last = counter.last_agent_at
    return last is not None and datetime.now(timezone.utc) - last > AGENT_COOLDOWN


async def _needs_person(key: str, failure: WebappFailureSpec, why: str, handling: Optional[WebappHandlingSpec] = None,
                        tried: Optional[list[str]] = None) -> None:
    detail = why.strip().splitlines()[0] if why.strip() else "the app does not come up"
    if tried:
        detail += f" (tried: {'; '.join(tried)})"
    await record.set_state(key, LifecycleState.NEEDS_PERSON, detail, failure=failure, recovery="", agent_call="")


async def _act(app, failure: WebappFailureSpec, action: HandlingAction, arg: str, *, label: str, display: str,
               counts: dict) -> Optional[WebappFailureSpec]:
    """Do ``action`` for ``failure``, then bring the app up again. None when it held; else what failed now."""
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415

    key = str(app.id)
    rec = record.read(key)
    await record.set_state(key, LifecycleState.RECOVERING, f"{label} for: {failure.text[:120]}", recovery=label,
                           failure=failure, attempts=record.bumped(rec, failure.fingerprint, **counts))
    if action in (HandlingAction.RESTART, HandlingAction.FREE_PORTS):
        await webapp_setup.stop(key)
    elif action is HandlingAction.REINSTALL:
        await record.change(key, install_stamp="stale")
    elif action is HandlingAction.REBUILD:
        await record.change(key, build_stamp="stale")
    elif action is HandlingAction.RUN:
        await _start_app_verb(app, arg)
    elif action is HandlingAction.SETUP:
        owed = await _setup_node(app, arg)
        if owed is not None:
            return owed
    if failure.phase is FailurePhase.PAGE:
        await record.change(key, failure=None)
    return await _up(app, display=display)


async def _setup_node(app, node_id: str) -> Optional[WebappFailureSpec]:
    """Run one node of the project's setup tree (a dependency), and wait for it."""
    from flow_sdk.builtin.project_setup import _RUNS, start_setup  # noqa: PLC0415
    from flow_sdk.core.setup.load import _leaf_failure  # noqa: PLC0415

    project = await _project(app)
    if project is None or not node_id:
        return make(FailurePhase.DEPENDENCY, FailureCode.SETUP_OWED, f"no setup node {node_id!r} to run",
                    folder=app.asset_ref)
    await start_setup(project, root=node_id, load_after=True, connect_here=False)
    task = _RUNS.get((str(project.id), node_id))
    result = await asyncio.shield(task) if task is not None else None
    if result is not None and result.ok:
        return None
    why = (_leaf_failure(result.root) if result is not None else "") or (result.detail if result else "")
    return make(FailurePhase.DEPENDENCY, FailureCode.DEPENDENCY_DOWN, f"{node_id}: {why or 'did not set up'}",
                folder=app.asset_ref)


async def _start_app_verb(app, verb: str) -> None:
    import subprocess  # noqa: PLC0415

    from flow_sdk.builtin.webapp_setup import INSTALL_SECONDS, START_APP  # noqa: PLC0415

    folder = Path(app.asset_ref)
    if not verb or not (folder / START_APP).is_file():
        return
    await asyncio.to_thread(subprocess.run, ["python3", START_APP, verb], cwd=folder, capture_output=True,
                            timeout=INSTALL_SECONDS, check=False)


async def _agent(app, failure: WebappFailureSpec, *, hint: str, tried: list[str],
                 display: str) -> Optional[WebappFailureSpec]:
    """The one fixer, as a durable call any lane can see (``agent_call``); then the app up again."""
    key = str(app.id)
    rec = record.read(key)
    request = WebappFixRequest(webapp_id=key, app_name=str(app.name), project_id=str(app.project_id or ""),
                               folder=str(app.asset_ref), failure=failure, hint=hint, tried=tried)
    await record.set_state(key, LifecycleState.RECOVERING, "the fixer is repairing it", recovery="agent",
                           failure=failure, attempts=record.bumped(rec, failure.fingerprint, agent=1,
                                                                    last_agent_at=datetime.now(timezone.utc)))
    try:
        await _run_fixer(key, request)
    except Exception as exc:  # noqa: BLE001 — no fixer (no assistant, no credit) is a fact for the person
        logger.warning("web app %s: the fixer could not run: %s", app.name, exc)
        await record.change(key, agent_call="")
        return make(failure.phase, failure.code, f"{failure.raw or failure.text} — the fixer could not run: {exc}",
                    source=failure.source, folder=app.asset_ref).model_copy(update={"fingerprint": failure.fingerprint})
    await record.change(key, agent_call="")
    fresh = await _app(key) or app  # the fixer may have changed webapp.json
    if failure.phase is FailurePhase.PAGE:
        await record.change(key, failure=None)
    outcome = await _up(fresh, display=display)
    counter = record.read(key).counter(failure.fingerprint)
    await record.change(key, attempts=record.bumped(record.read(key), failure.fingerprint,
                                                    last_outcome="fixed" if outcome is None else "not_fixed"))
    del counter
    return outcome


async def _run_fixer(key: str, request: WebappFixRequest) -> None:
    """Start the shipped ``webapp-fixer`` op as a durable call, note it on the record, and wait for its answer.
    A call whose executor died (a backend restart) reads INTERRUPTED and is not run again."""
    from flow_sdk.builtin.compute_op import ComputeOp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_call_spec import CallState  # noqa: PLC0415

    ops = [op for op in await ComputeOp.get_all({"name": "webapp-fixer"}) if op.is_system()]
    if not ops:
        from flow_sdk.core.compute_op.runner import run_op  # noqa: PLC0415
        from flow_sdk.core.wizard.local_run import read_op  # noqa: PLC0415

        spec = read_op("webapp-fixer")
        if spec is None:
            raise RuntimeError("the webapp-fixer op is not installed")
        answer = await run_op(spec, input=request, trusted=True)
        if not answer.ok and not answer.ran:
            raise RuntimeError(answer.detail)
        return
    op = ops[0]
    call = await op.start(input=request, approved=True)
    await record.change(key, agent_call=f"{op.typeid}/{call.call_id}")
    while True:
        done = await op.get_call(call.call_id)
        if done is None or done.state is not CallState.RUNNING:
            break
        await asyncio.sleep(1.0)  # reading a completion record, not a budget: the agent op has its own
    if done is not None and done.state is CallState.COMPLETED and done.result is not None:
        if not done.result.ran and not done.result.ok:
            raise RuntimeError(done.result.detail)
    elif done is not None and done.state is not CallState.COMPLETED:
        raise RuntimeError(done.error or f"the fixer call ended {done.state.value}")


# ── what the page says, and stopping ─────────────────────────────────────────


async def report_page(app: Any, errors: list[dict], *, load_id: str = "", settled: bool = True) -> dict:
    """What the app's page threw (``service_endpoint/<id>/page-report``), decided by its handlings. A report
    for another document than the one last served is stale and decides nothing. A failure no handling
    ignores moves the app to DEGRADED and starts recovery at the ladder."""
    key = _bare(app.id)
    rec = record.read(key, str(app.project_id or ""))
    from flow_sdk.server.reporter_relay import latest_load  # noqa: PLC0415

    served = latest_load(rec.ports.get(""))
    stale = bool(load_id and served and load_id != served)
    failures = [of_page(str(e.get("text", "")), str(e.get("source") or "page"), folder=app.asset_ref)
                for e in errors or [] if isinstance(e, dict) and e.get("text")]
    try:
        own = await asyncio.to_thread(handlings.load, app.asset_ref)
    except handlings.HandlingFileError:
        own = []
    decided = [(f, handlings.match(f, own)) for f in failures]
    open_ = [(f, h) for f, h in decided if h is None or h.action is not HandlingAction.IGNORE]
    for f, h in decided:
        if h is not None and h.action is HandlingAction.IGNORE:
            handlings.log(app.asset_ref, f, "ignore", "fixed", h.id)
    recovering = False
    if not stale and open_:
        failure, _h = open_[0]
        if rec.state in (LifecycleState.UP, LifecycleState.DOWN, LifecycleState.STARTING):
            await record.set_state(key, LifecycleState.DEGRADED, failure.text[:200], failure=failure)
        if not running(key):
            await bring_up(app, reason="page", failure=failure)
        recovering = True
    elif not stale and settled and rec.failure is not None and rec.failure.phase is FailurePhase.PAGE \
            and rec.state is LifecycleState.DEGRADED:
        await record.set_state(key, LifecycleState.UP, "up", failure=None)
    return {
        "usable": not open_,
        "stale": stale,
        "recovering": recovering,
        "decisions": [{"source": f.source, "text": f.raw or f.text, "fingerprint": f.fingerprint,
                       "action": "ignore" if h is not None and h.action is HandlingAction.IGNORE else "recover",
                       "rule": h.id if h is not None else None, "fix": h.action.value if h is not None else ""}
                      for f, h in decided],
    }


async def stop(app: Any) -> WebappLifecycleSpec:
    """Stop the app's run (if any) and its processes."""
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415

    key = _bare(app.id)
    task = _TASKS.get(key)
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    rec = record.read(key)
    for name, pid in rec.pids.items():
        if name in ("install", "build") and pid:
            from flow_sdk.core import dev_server  # noqa: PLC0415

            await asyncio.to_thread(dev_server.stop_group, int(pid))
    await webapp_setup.stop(key)
    return await record.set_state(key, LifecycleState.DOWN, "stopped", recovery="", agent_call="",
                                  pids={k: v for k, v in rec.pids.items() if k not in ("install", "build")})


async def adopt_on_start() -> None:
    """Backend start: a record left mid-run (its run died with the old backend) is settled by reading what runs
    now — never by redoing work. Best effort, in the background."""
    from flow_sdk.fs_store.record_paths import data_dir_for  # noqa: PLC0415

    base = data_dir_for("micro_app", "x").parent
    if not base.is_dir():
        return
    for path in base.glob(f"*/{record.RECORD_FILE}"):
        rec = record.read(path.parent.name)
        if rec.state in BUSY or rec.agent_call:
            await record.change(rec.webapp_id, state=LifecycleState.DOWN, detail="the backend restarted mid-run",
                                recovery="", agent_call="", push=False)


__all__ = ["adopt_on_start", "bring_up", "report_page", "running", "stop"]

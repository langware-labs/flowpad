"""The one diagnose runner: resolve a diagnose, call it, always answer a ``DiagnosisSpec``.

    ctx = FlowContextSpec(purpose="report", project_path=..., user_report="...")
    diagnosis = await run_diagnose(ctx)

1. The **baseline** (environment + log tails) is collected first, from files and settings only.
2. The diagnose is resolved -- the project's own (``<project>/agentic-assets/diagnose/*``), else the
   shipped ``flowpad`` one -- and ``diagnose(ctx)`` runs on its OWN thread and event loop, inside
   an Activity, for at most ``DiagnoseSpec.timeout_s``. Its own thread, because it is a project's
   code: one that blocks (``time.sleep``, a sync socket) must not freeze the backend, and a
   cancelled coroutine cannot be made to stop -- the runner stops waiting instead.
3. What it answers is validated as a ``DiagnosisSpec``. Anything else -- no diagnose, an import
   error, a raise, a hang past the budget, an answer that is not a diagnosis -- answers the
   baseline with ``status="partial"`` and the reason in ``errors``. ``run_diagnose`` never raises.
"""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from flow_sdk.diagnose import baseline
from flow_sdk.schema.data_spec.diagnose_spec import (
    DIAGNOSE_FILE,
    DiagnoseSpec,
    DiagnosisSpec,
    DiagnosisStatus,
    FlowContextSpec,
)

logger = logging.getLogger(__name__)

#: The shipped diagnose a project without its own is diagnosed by.
GENERIC = "flowpad"

#: Called with each progress line a diagnose reports (``progress(...)``), on the runner's loop.
Emit = Callable[[str], None]

_reporter: contextvars.ContextVar[Optional[Emit]] = contextvars.ContextVar("diagnose_reporter", default=None)


class DiagnoseError(RuntimeError):
    """A diagnose could not be found, read or imported."""


def progress(text: str) -> None:
    """What a diagnose is doing now (``"checking the hub"``) -- shown on its activity and stream.
    A no-op outside a run, so a diagnose can be called from a test as a plain function."""
    report = _reporter.get()
    if report is not None:
        try:
            report(text)
        except Exception:  # noqa: BLE001 — reporting never sinks a diagnose
            pass


# ── finding a diagnose ───────────────────────────────────────────────────────


def _diagnoses_under(root: Path) -> list[tuple[Path, DiagnoseSpec]]:
    out = []
    for doc in sorted((root / "agentic-assets" / "diagnose").glob(f"*/{DIAGNOSE_FILE}")):
        try:
            out.append((doc.parent, DiagnoseSpec.model_validate_json(doc.read_text(encoding="utf-8"))))
        except (OSError, ValueError) as exc:
            raise DiagnoseError(f"{doc} is invalid: {exc}") from exc
    return out


def shipped_root() -> Path:
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

    return flowpad_assistant_project_root()


def resolve_diagnose(project_path: Optional[str | Path]) -> tuple[Path, DiagnoseSpec]:
    """The diagnose for a project: its own (the first by folder name), else the shipped one."""
    if project_path:
        own = _diagnoses_under(Path(project_path))
        if own:
            return own[0]
    for folder, spec in _diagnoses_under(shipped_root()):
        if folder.name == GENERIC:
            return folder, spec
    raise DiagnoseError(f"the shipped {GENERIC!r} diagnose is missing under {shipped_root()}")


def _load(folder: Path, spec: DiagnoseSpec) -> Callable[..., Any]:
    from flow_sdk.ingest.driver_registry import DriverLoadError, load_module  # noqa: PLC0415

    try:
        module = load_module(folder, Path(spec.entry).stem)
    except DriverLoadError as exc:
        raise DiagnoseError(str(exc)) from exc
    fn = getattr(module, "diagnose", None)
    if not callable(fn):
        raise DiagnoseError(f"{folder / spec.entry} defines no diagnose(ctx)")
    return fn


async def project_path_of(project_id: Optional[str]) -> Optional[str]:
    """A project's folder on this machine, by its local id."""
    if not project_id:
        return None
    try:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(project_id)
        return getattr(project, "fs_storage_mount_path", None) if project else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("[diagnose] project %s not found: %s", project_id, exc)
        return None


# ── running one ──────────────────────────────────────────────────────────────


def _call_on_own_thread(fn: Callable[..., Any], ctx: FlowContextSpec, report: Emit) -> "asyncio.Future[Any]":
    """``fn(ctx)`` on a daemon thread with its own loop; the future resolves on the caller's loop."""
    loop = asyncio.get_running_loop()
    done: asyncio.Future[Any] = loop.create_future()

    def settle(setter: Callable[[Any], None], value: Any) -> None:
        if not done.done():
            setter(value)

    def threadsafe_report(text: str) -> None:
        loop.call_soon_threadsafe(report, text)

    def body() -> None:
        _reporter.set(threadsafe_report)
        try:
            value = fn(ctx)
            if inspect.iscoroutine(value):
                value = asyncio.run(value)
            loop.call_soon_threadsafe(settle, done.set_result, value)
        except BaseException as exc:  # noqa: BLE001 — every failure is the runner's to report
            try:
                loop.call_soon_threadsafe(settle, done.set_exception, exc)
            except RuntimeError:  # the caller's loop is gone; nobody is waiting
                pass

    threading.Thread(target=body, name=f"diagnose-{ctx.origin or 'run'}", daemon=True).start()
    return done


def _as_diagnosis(value: Any) -> DiagnosisSpec:
    if isinstance(value, DiagnosisSpec):
        return value
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    if not isinstance(value, dict):
        raise ValueError(f"diagnose returned {type(value).__name__}, not a diagnosis")
    value = {k: v for k, v in value.items() if k != "spec_kind"}
    return DiagnosisSpec.model_validate(value)


def _activity(spec: DiagnoseSpec):
    """The run's background activity -- one per run, shown in the footer like any other."""
    from flow_sdk.activity import Activity  # noqa: PLC0415
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    # Its own root, so the footer shows THIS run's label (a shared ``diagnose`` root shows only
    # "diagnose · 1/1"). The claim's liveness bound outlives the diagnose's own budget, so it
    # never ends a run early.
    return Activity.claim(f"diagnose-{spec.name}-{mint_uuid()[:8]}", timeout_seconds=int(spec.timeout_s) + 60)


async def run_diagnose(
    ctx: FlowContextSpec,
    *,
    emit: Optional[Emit] = None,
    label: Optional[str] = None,
    resolve: Callable[[Optional[str]], tuple[Path, DiagnoseSpec]] = resolve_diagnose,
) -> DiagnosisSpec:
    """Diagnose ``ctx`` -- always a ``DiagnosisSpec``, never a raise (see the module docstring).

    ``emit`` hears each progress line (the CLI prints them, the UI streams them). ``label`` names
    the background activity the run shows as (``"Diagnosing for Dana"``).
    """
    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    if not ctx.project_path and ctx.project_id:
        ctx = ctx.model_copy(update={"project_path": await project_path_of(ctx.project_id)})
    # Files, subprocesses (git config) and a module import: off the caller's loop, which is the
    # backend's when someone asks for help.
    environment, logs = await asyncio.to_thread(lambda: (baseline.environment(), baseline.log_tails()))
    if not ctx.instance:
        ctx = ctx.model_copy(update={"instance": environment.instance})
    base = DiagnosisSpec(
        status=DiagnosisStatus.PARTIAL,
        title="Diagnosis incomplete",
        summary="The diagnosis could not finish; what is here is the machine and its recent logs.",
        symptoms=ctx.user_report,
        environment=environment,
        logs=logs,
        context=ctx,
        started_at=started_at,
    )

    def finish(diagnosis: DiagnosisSpec) -> DiagnosisSpec:
        return diagnosis.model_copy(update={"elapsed_ms": int((time.monotonic() - started) * 1000)})

    def failed(name: str, reason: str) -> DiagnosisSpec:
        logger.warning("[diagnose] %s: %s", name or "-", reason)
        return finish(base.model_copy(update={"diagnose": name, "errors": [reason]}))

    def resolve_and_load() -> tuple[DiagnoseSpec, Callable[..., Any]]:
        folder, spec = resolve(ctx.project_path)
        return spec, _load(folder, spec)

    try:
        spec, fn = await asyncio.to_thread(resolve_and_load)
    except Exception as exc:  # noqa: BLE001 — DiagnoseError, or anything a broken folder throws
        return failed("", str(exc))

    async with _activity(spec) as act:
        act.label(label or f"Diagnosing ({spec.title or spec.name})")

        def report(text: str) -> None:
            act.current(text)
            if emit is not None:
                emit(text)

        def give_up(reason: str) -> DiagnosisSpec:
            act.fail(reason)  # sticky: the claim's own done() on exit leaves it failed
            return failed(spec.name, reason)

        try:
            value = await asyncio.wait_for(_call_on_own_thread(fn, ctx, report), timeout=spec.timeout_s)
        except asyncio.TimeoutError:
            return give_up(f"{spec.name} did not finish within {spec.timeout_s:g}s")
        except Exception as exc:  # noqa: BLE001
            return give_up(f"{spec.name} failed: {type(exc).__name__}: {exc}")
        try:
            diagnosis = _as_diagnosis(value)
        except ValueError as exc:
            return give_up(f"{spec.name} answered something that is not a diagnosis: {exc}")

    # What the diagnose left out, the baseline fills: a helper always reads the machine.
    update: dict[str, Any] = {"diagnose": spec.name, "context": ctx, "started_at": started_at}
    if diagnosis.environment == type(diagnosis.environment)():
        update["environment"] = base.environment
    if not diagnosis.logs:
        update["logs"] = base.logs
    if not diagnosis.symptoms:
        update["symptoms"] = ctx.user_report
    return finish(diagnosis.model_copy(update=update))

"""Evidence that an instance — and so the engine — is used from the command line, outside the desktop.

The Windows uninstaller (FLOWPAD-2250) must not remove an engine, or an instance's data, that
someone also uses through ``flow`` directly. Nothing else on disk says so, so every CLI invocation
leaves a stamp:

* ``<instance_dir>/.cli_used`` — ``{"first", "last", "version"}``: this instance was driven by a
  ``flow`` that the desktop did not run. ``last`` is refreshed at most once an hour.
* ``<flow_home>/global/cli-stamp-since`` — ``{"version", "since", "preexisting"}``: written once,
  by the first engine that stamps. Without it, a missing ``.cli_used`` means "unknown" (an older
  engine never stamped), not "never used". ``preexisting`` names the instances an older engine
  already ran against — anything in the folder other than the OS's own files (``NOT_ENGINE_TRACES``)
  predates the process that wrote the marker: that engine may have driven them from the command
  line unrecorded, so for them a missing stamp stays "unknown". The folder itself proves nothing:
  the desktop creates ``instances/prod`` at launch, before any engine runs.

  Only the ``flow`` entry point writes the marker, and it runs before anything it starts: the
  desktop launches the engine as ``flow start``, so the monitor and the server (and the logs,
  locks and state files they write) come after the marker, never before it.

Not stamped: a process with ``FLOWPAD_DESKTOP=1`` (the desktop's own ``flow`` calls, its backend,
and every worker the backend spawns — they inherit it), and the ``hooks`` group (the Claude Code
integration the desktop installed). Stamping never raises: it must not break a CLI command.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from flow_sdk._version import __version__
from flow_sdk.instance_settings.base_settings import ENV_FLOWPAD_DESKTOP

logger = logging.getLogger(__name__)

CLI_USE_STAMP = ".cli_used"
STAMP_SINCE_FILENAME = "cli-stamp-since"
REFRESH_SECONDS = 3600

#: Subcommands that are the desktop's own integration, not independent use of the engine.
NOT_INDEPENDENT_USE = frozenset({"hooks"})


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _process_started() -> float:
    import psutil  # noqa: PLC0415

    return psutil.Process().create_time()


#: The OS's own files. The desktop only creates the folder, at launch, before any engine runs;
#: anything else there — data, config, logs, locks — was an engine's, older or this one.
NOT_ENGINE_TRACES = frozenset({".DS_Store", "desktop.ini", "Thumbs.db"})


def _is_trace(path: Path) -> bool:
    return path.name not in NOT_ENGINE_TRACES


def _created(path: Path) -> float:
    st = path.stat()
    # Windows' st_ctime is the creation time; st_birthtime where the platform has it.
    return getattr(st, "st_birthtime", st.st_ctime)


def _older(path: Path, started: float) -> bool:
    try:
        return path.exists() and _created(path) < started
    except OSError:
        return True  # unreadable: assume it is old


def _engine_ran_before(instance_dir: Path, started: float, elsewhere: list[Path]) -> bool:
    """Something an engine wrote — in the folder, or at an overridden path — predates ``started``."""
    try:
        entries = [p for p in instance_dir.iterdir() if _is_trace(p)]
    except OSError:
        return True  # unreadable: assume an engine used it
    return any(_older(p, started) for p in entries) or any(_older(p, started) for p in elsewhere)


def _overridden_paths() -> list[Path]:
    """The database / records an env override moved out of the instance folder (this process's instance)."""
    from flow_sdk.instance_settings.base_settings import ENV_FS_RECORD_PATH, ENV_SQLITE_DATABASE_PATH  # noqa: PLC0415

    return [Path(v) for v in (os.environ.get(ENV_SQLITE_DATABASE_PATH), os.environ.get(ENV_FS_RECORD_PATH)) if v]


def instances_before(instances_root: Path, started: float, *, current: str | None = None) -> list[str]:
    """The instances an engine ran against before ``started``. Never raises.

    ``current`` is this process's instance: its env overrides (database, records) count too.
    """
    names = []
    try:
        entries = list(instances_root.iterdir())
    except OSError:
        return names
    for p in entries:
        try:
            if not p.is_dir():
                continue
        except OSError:
            names.append(p.name)  # unreadable: assume an engine used it
            continue
        elsewhere = _overridden_paths() if p.name == current else []
        if _engine_ran_before(p, started, elsewhere):
            names.append(p.name)
    return sorted(names)


def ensure_stamping_marker(global_dir: Path, *, started: float | None = None, current: str | None = None) -> None:
    """Record, once, that this engine stamps CLI use. Never raises."""
    marker = global_dir / STAMP_SINCE_FILENAME
    try:
        if marker.exists():
            return
        started = _process_started() if started is None else started
        preexisting = instances_before(global_dir.parent / "instances", started, current=current)
        global_dir.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(marker, {"version": __version__, "since": time.time(), "preexisting": preexisting})
    except Exception as e:  # noqa: BLE001 — evidence only; a missing marker means "unknown"
        logger.debug("Could not write %s: %s", marker, e)


def stamp_instance_use(instance_dir: Path, *, now: float | None = None) -> None:
    """Record CLI use of one instance. Never raises; never creates the instance directory."""
    now = time.time() if now is None else now
    stamp = instance_dir / CLI_USE_STAMP
    try:
        if not instance_dir.is_dir():
            return
        existing = _read_json(stamp)
        if existing and isinstance(existing.get("last"), (int, float)) and now - existing["last"] < REFRESH_SECONDS:
            return
        first = existing.get("first") if existing and isinstance(existing.get("first"), (int, float)) else now
        _write_json_atomic(stamp, {"first": first, "last": now, "version": __version__})
    except OSError as e:
        logger.debug("Could not write %s: %s", stamp, e)


def is_independent_use(subcommand: str | None, environ=os.environ) -> bool:
    return environ.get(ENV_FLOWPAD_DESKTOP) != "1" and subcommand not in NOT_INDEPENDENT_USE


def record_cli_use(subcommand: str | None) -> None:
    """The CLI entry point's hook. Never raises."""
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        settings = get_instance_settings()
        ensure_stamping_marker(settings.global_dir, current=settings.instance_name)
        if is_independent_use(subcommand):
            stamp_instance_use(settings.instance_dir)
    except Exception as e:  # noqa: BLE001 — evidence only; a CLI command must never fail on it
        logger.debug("CLI use not recorded: %s", e)

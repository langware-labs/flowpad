import logging
import os
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Shared log path utilities
# ---------------------------------------------------------------------------

def _logs_base() -> Path:
    """Resolve the active logs dir from the per-instance settings."""
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().logs_dir


def _timestamped_filename() -> str:
    """Return a log filename like '4Jan2026_23_45_11.log'."""
    now = datetime.now()
    day = str(now.day)
    return f"{day}{now.strftime('%b%Y_%H_%M_%S')}.log"


def generate_timestamped_log_path(subdirectory: str) -> Path:
    """Create ``<logs_dir>/{subdirectory}/`` and return a timestamped file path inside it."""
    log_dir = _logs_base() / subdirectory
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / _timestamped_filename()


def cleanup_old_logs(directory: Path, max_age_days: int = 7, max_files: int = 15) -> None:
    """Delete ``*.log`` files older than *max_age_days* or exceeding *max_files*, always keeping at least one."""
    if not directory.is_dir():
        return
    log_files = sorted(directory.glob("*.log"), key=lambda f: f.stat().st_mtime)
    if len(log_files) <= 1:
        return
    # Enforce max file count (delete oldest first)
    while len(log_files) > max_files:
        log_files.pop(0).unlink(missing_ok=True)
    # Enforce max age on remaining files (never delete the newest)
    cutoff = time.time() - max_age_days * 86400
    for f in log_files[:-1]:
        if f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)

from rich.console import Console
from rich.text import Text

# Try to import FlowPad config, fall back to defaults
try:
    from flow_sdk.config import default_service_config
    from flow_sdk.config import DeployEnv
    deploy_env = default_service_config.deploy_env
    is_local = deploy_env == DeployEnv.LOCAL
    is_development = default_service_config.development
except ImportError:
    is_local = True
    is_development = True
    # Create a minimal config stub for backward compatibility
    class _MinimalConfig:
        development = True
    default_service_config = _MinimalConfig()

# Initialize rich console only for local
if is_local:
    logging.info("Rich logging enabled")
    console = Console()
else:
    logging.info("Rich logging disabled")
    console = None

# Dictionary to track last log time for each log level
_last_log_time: dict[int, float | None] = {
    logging.ERROR: None,
    logging.INFO: None,
    logging.DEBUG: None,
    logging.WARNING: None,
}
start_time = time.time()

# File logging state — set by init_dev_file_logging(), read by _log_with_timer().
log_to_folder: bool = False
_log_file: Path | None = None

__logger = logging.getLogger(__name__)
# Use LOG_LEVEL env var if set, otherwise fall back to original default (DEBUG in dev, WARNING otherwise)
_log_level_str = os.getenv("LOG_LEVEL", "").upper()
_log_level = getattr(logging, _log_level_str, None) if _log_level_str else None
if _log_level is None:
    _log_level = logging.DEBUG if default_service_config.development else logging.WARNING
__logger.setLevel(_log_level)


def init_dev_file_logging() -> Path | None:
    """Mirror all log output to a timestamped file on disk (development only).

    PyCharm/uvicorn keep printing to the console; this *additionally* mirrors
    every log line to a single per-boot file under the per-instance *server*
    logs directory ``<flow_home>/instances/<instance_name>/logs/server/`` so a
    session can be inspected after the fact.

    There is exactly **one** file per boot, sourced two ways depending on how
    the server was launched:

      * **Launched by the monitor** (``launch.py`` / desktop): the monitor has
        already redirected the server's *stderr* into a ``server/<ts>.log`` and
        passes that path via ``FLOWPAD_SERVER_LOG_PATH``. The root
        ``StreamHandler`` (``configure_logging``) writes the full
        correlation-formatted logging tree to stderr — i.e. into that same file
        — so we just adopt the path (no second ``FileHandler``: that is what
        used to produce a duplicate file). The rich-console timer lines are
        written into it by ``_log_with_timer``.
      * **Standalone direct run** (``uv run -m flow_sdk.server.run``): stderr
        goes to the terminal, not a file, so we mint a ``server/<ts>.log`` and
        attach a ``FileHandler`` to the root logger to mirror the tree to disk.

    No-op (returns None) outside development mode (e.g. a prod cloud deploy).
    """
    global log_to_folder, _log_file

    if not is_development:
        return None

    # Launched by the monitor: adopt the file its stderr is already going to.
    # The root StreamHandler (-> stderr -> this file) carries the full tree, so
    # adding a FileHandler here would write every line twice into one file.
    monitor_log_path = os.getenv("FLOWPAD_SERVER_LOG_PATH")
    if monitor_log_path:
        _log_file = Path(monitor_log_path)
        log_to_folder = True
        return _log_file

    # Standalone direct run: mint a server/ file and mirror the tree via a
    # FileHandler. Every ``*.log`` lives under server/ / monitor/ / main_desktop/.
    log_dir = _logs_base() / "server"
    log_dir.mkdir(parents=True, exist_ok=True)
    cleanup_old_logs(log_dir)
    _log_file = log_dir / _timestamped_filename()
    _log_file.touch()
    log_to_folder = True

    # Mirror the stdlib logging tree into the same file. The marker attribute
    # guards against re-adding the handler on a reloader restart.
    root = logging.getLogger()
    if not any(getattr(h, "_flowpad_dev_file", False) for h in root.handlers):
        from flow_sdk.logging_setup import CorrelationFilter, make_formatter

        handler = logging.FileHandler(str(_log_file))
        # Same correlation-aware format as the root stream handler so the file
        # mirror and console agree.
        handler.setFormatter(make_formatter())
        handler.addFilter(CorrelationFilter())
        handler.setLevel(logging.DEBUG)
        handler._flowpad_dev_file = True  # type: ignore[attr-defined]
        root.addHandler(handler)
        if root.level == logging.NOTSET or root.level > logging.INFO:
            root.setLevel(logging.INFO)
    return _log_file


def _on_first_log(level: int | None = None) -> None:
    if level is None:
        getattr(__logger, logging.getLevelName(logging.INFO).lower())("\n")


def _log_with_timer(level: int, msg: str, style: str) -> None:
    # Check if the message should be logged based on the current logging level
    # first log call on all levels
    from flow_sdk.logging_setup import format_correlation

    # Shared correlation suffix (instance/request/user/action/entity/trace) so
    # the rich console and file mirror agree with the stdlib formatter. Empty
    # string outside a request — see logging_setup.format_correlation.
    corr = format_correlation()
    is_first_log_call = all([_last_log_time[level_time] is None for level_time in _last_log_time])
    if is_first_log_call:
        _on_first_log()
    first_log_call_on_level = _last_log_time[level] is None
    if first_log_call_on_level:
        _on_first_log(level)
    if __logger.isEnabledFor(level):
        current_time = time.time()
        last_log_time = _last_log_time[level]
        if last_log_time is None:
            elapsed = 0.0
        else:
            elapsed = current_time - last_log_time

        _last_log_time[level] = current_time
        overall_time = current_time - start_time

        timer_info = f" [{elapsed:.2f}s / {overall_time:.2f}s]"

        # Use rich for local, regular logging elsewhere
        if console:
            text = Text()
            # Format timestamp like your original format
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S,%f")[:-3]  # Remove last 3 digits from microseconds
            level_name = logging.getLevelName(level)
            text.append(f"{timestamp} [{level_name}]{corr} {msg}{timer_info}", style=style)
            console.print(text)
        else:
            # Non-local: route through stdlib logging. The root handler's
            # CorrelationFilter adds the correlation suffix, so don't prepend it
            # here (it would double up).
            getattr(__logger, logging.getLevelName(level).lower())(f"{msg}{timer_info}")

        # File mirror for the rich-console path ONLY. The stdlib path (else
        # branch above) routes through __logger → the root FileHandler, which
        # already writes this line to the same dev file; mirroring here too
        # would double every line (and re-open the file per call). So guard on
        # ``console``: only the rich path, which never touches the logging tree,
        # needs the explicit write.
        if console and log_to_folder and _log_file:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S,%f")[:-3]
            level_name = logging.getLevelName(level)
            with open(_log_file, "a") as f:
                f.write(f"{timestamp} [{level_name}]{corr} {msg}{timer_info}\n")


def error(err: str) -> None:
    _log_with_timer(logging.ERROR, err, "red")


def highlighted_error(err: str) -> None:
    _log_with_timer(logging.ERROR, err, "black on yellow")


def info(msg: str) -> None:
    _log_with_timer(logging.INFO, msg, "white")


def debug(msg: str) -> None:
    _log_with_timer(logging.DEBUG, msg, "bright_black")


def warning(msg: str) -> None:
    _log_with_timer(logging.WARNING, msg, "black on bright_blue")


def warn(msg: str) -> None:
    warning(msg)

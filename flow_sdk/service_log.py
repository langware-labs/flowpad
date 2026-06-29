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

    PyCharm/uvicorn keep printing to the console; this *additionally* writes
    every log line to the per-instance logs directory
    ``<flow_home>/instances/<instance_name>/logs/<timestamp>.log`` so a
    session can be inspected after the fact. Captures both logging paths:

      * this module's ``info``/``debug``/... (rich-console path) — via the
        existing ``log_to_folder`` / ``_log_file`` file writer.
      * the stdlib ``logging`` tree (uvicorn, ``flow_sdk.*`` module loggers) —
        via a ``FileHandler`` attached to the root logger, pointed at the
        same file.

    No-op (returns None) outside development mode (e.g. a prod cloud deploy).
    """
    global log_to_folder, _log_file

    if not is_development:
        return None

    # ``_logs_base()`` already resolves to the canonical per-instance logs
    # directory (instance_settings.logs_dir) — write session logs straight
    # into it, no extra subdirectory.
    log_dir = _logs_base()
    log_dir.mkdir(parents=True, exist_ok=True)
    cleanup_old_logs(log_dir)
    _log_file = log_dir / _timestamped_filename()
    _log_file.touch()
    log_to_folder = True

    # Mirror the stdlib logging tree into the same file. The marker attribute
    # guards against re-adding the handler on a reloader restart.
    root = logging.getLogger()
    if not any(getattr(h, "_flowpad_dev_file", False) for h in root.handlers):
        handler = logging.FileHandler(str(_log_file), encoding="utf-8")
        handler.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        )
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
    from flow_sdk.request_context.methods import get_current_request_info

    request_info = get_current_request_info()
    msg = f"-{request_info.instance_counter}- {msg}" if request_info else f"-- {msg}"
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
            text.append(f"{timestamp} [{level_name}] {msg}{timer_info}", style=style)
            console.print(text)
        else:
            # Use regular logging which will respect your basicConfig format
            getattr(__logger, logging.getLevelName(level).lower())(f"{msg}{timer_info}")

        # Write to file if file logging enabled (desktop mode)
        if log_to_folder and _log_file:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S,%f")[:-3]
            level_name = logging.getLevelName(level)
            try:
                with open(_log_file, "a", encoding="utf-8") as f:
                    f.write(f"{timestamp} [{level_name}] {msg}{timer_info}\n")
            except OSError as exc:
                __logger.warning("Dev log mirror write skipped: %s", exc)


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

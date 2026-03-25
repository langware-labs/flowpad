import logging
import os
import time
from datetime import datetime
from pathlib import Path

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

# File logging variables (desktop mode only)
log_folder_path: str | None = None
log_to_folder: bool = False
log_files_limit: int = 10
_log_file: Path | None = None

__logger = logging.getLogger(__name__)
# Use LOG_LEVEL env var if set, otherwise fall back to original default (DEBUG in dev, WARNING otherwise)
_log_level_str = os.getenv("LOG_LEVEL", "").upper()
_log_level = getattr(logging, _log_level_str, None) if _log_level_str else None
if _log_level is None:
    _log_level = logging.DEBUG if default_service_config.development else logging.WARNING
__logger.setLevel(_log_level)


def init_file_logging(path: str) -> None:
    """Initialize file logging for desktop mode.

    Args:
        path: Path to the log folder. Created if it doesn't exist.
    """
    global log_folder_path, log_to_folder, _log_file

    log_folder = Path(path)
    log_folder.mkdir(parents=True, exist_ok=True)
    log_folder_path = str(log_folder)

    # Get existing log files sorted by modification time (oldest first)
    existing_logs = sorted(log_folder.glob("*.log"), key=lambda f: f.stat().st_mtime)

    # Delete oldest files if at or exceeding limit
    while len(existing_logs) >= log_files_limit:
        oldest = existing_logs.pop(0)
        oldest.unlink()

    # Create new log file with date format: 4Jan2026_23_45_11.log
    # Use cross-platform approach: format day separately to avoid leading zero
    now = datetime.now()
    day = str(now.day)  # Remove leading zero by converting to int then string
    timestamp = f"{day}{now.strftime('%b%Y_%H_%M_%S')}"
    _log_file = log_folder / f"{timestamp}.log"
    _log_file.touch()

    log_to_folder = True


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
            with open(_log_file, "a") as f:
                f.write(f"{timestamp} [{level_name}] {msg}{timer_info}\n")


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

"""OpenCode CLI driver package."""

from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import (
    CONFIG_FILENAME,
    SKILLS_SUBDIR,
    build_config,
    opencode_config_path_for_process,
    write_process_config,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.driver import OpenCodeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.event_to_flowdata import (
    OpenCodeEventConverter,
    convert_event,
    convert_line,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import (
    assemble_session_jsonl,
    external_session_ids,
    find_latest_opencode_session,
    find_opencode_session,
    load_session_history,
    load_transcript_history,
    opencode_data_dir,
    opencode_db_path,
    opencode_session_projection_path,
    opencode_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.status import opencode_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import (
    CANCEL_GRACE_SECONDS,
    OpenCodeCLIStreamWorker,
)

__all__ = [
    "CANCEL_GRACE_SECONDS",
    "CONFIG_FILENAME",
    "SKILLS_SUBDIR",
    "OpenCodeAgentOptions",
    "OpenCodeCLIStreamWorker",
    "OpenCodeDriver",
    "OpenCodeEventConverter",
    "assemble_session_jsonl",
    "build_config",
    "convert_event",
    "convert_line",
    "external_session_ids",
    "final_end_frame",
    "find_latest_opencode_session",
    "find_opencode_session",
    "load_session_history",
    "load_transcript_history",
    "opencode_config_path_for_process",
    "opencode_data_dir",
    "opencode_db_path",
    "opencode_session_projection_path",
    "opencode_tail_status",
    "opencode_transcript_path_for_process",
    "write_process_config",
]

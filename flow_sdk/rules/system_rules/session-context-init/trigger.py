"""Inject session_id into session record on SessionStart."""

import logging
from pathlib import Path

from flow_sdk.rules.trigger_executor import Action

logger = logging.getLogger(__name__)


def evaluate(hooks_data: dict, transcript: list) -> Action | None:
    hook_event = hooks_data.get("hookEvent", "")
    if hook_event != "SessionStart":
        return None

    session_id = hooks_data.get("session_id", "")
    if not session_id:
        return None

    # Try to create session via skillit records if available #2
    flow_output_directory = ""
    try:
        from plugin_records.skillit_records import skillit_records
        session = skillit_records.create_session(session_id)
        cwd = hooks_data.get("cwd", "")
        if cwd:
            session.cwd = cwd
            session.save()
        flow_output_directory = str(session.output_dir)
    except ImportError:
        logger.debug("plugin_records not available, skipping session record creation")
    except Exception as e:
        logger.debug(f"Failed to create session record: {e}")

    skillit_home = str(Path(__file__).resolve().parents[4])  # up to flow_sdk root

    context_parts = [
        "Session initialized.",
        f"session_id={session_id}",
        f"skillit_home={skillit_home}",
    ]
    if flow_output_directory:
        context_parts.append(f"flow_output_directory={flow_output_directory}")
        context_parts.append("Remember to write to <flow_output_directory> above when asked to use 'flow output dir'.")

    logger.debug(f"[System context Rule]: session={session_id}, flow_output_directory dir: {flow_output_directory}")

    return Action(
        type="add_context",
        params={"content": "\n".join(context_parts)},
    )

"""Module for fetching and parsing worker sessions."""

import json
import logging
import re
from pathlib import Path

from flow_sdk.config import AGENT_MOUNT_FOLDER


def get_first_user_message(content_items):
    """Extract the first non-warmup user message from content items."""
    if not content_items:
        return ""

    # Handle simple string content
    if isinstance(content_items, str):
        text = content_items.strip()
        if text and text != "Warmup":
            return text[:100] + "..." if len(text) > 100 else text
        return ""

    # Handle array of content items
    if not isinstance(content_items, list):
        return ""

    for item in content_items:
        if not isinstance(item, dict):
            continue

        if item.get("type") == "text":
            text = item.get("text", "")
            if not text:
                continue

            text = text.strip()
            if text and text != "Warmup":
                return text[:100] + "..." if len(text) > 100 else text

    return ""


def parse_jsonl(file_path, sessions, summaries, uuid_to_session):
    """Parse a JSONL file and extract session information."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue

                try:
                    entry = json.loads(line)
                    entry_type = entry.get("type")
                    session_id = entry.get("sessionId")
                    uuid = entry.get("uuid")

                    if entry_type == "summary":
                        leaf_uuid = entry.get("leafUuid")
                        summary = entry.get("summary")
                        if leaf_uuid and summary:
                            summaries[leaf_uuid] = summary

                    if session_id and uuid:
                        uuid_to_session[uuid] = session_id

                    if session_id:
                        if session_id not in sessions:
                            sessions[session_id] = {
                                "sessionId": session_id,
                                "firstUserMessage": "",
                                "summary": None,
                                "timestamp": entry.get("timestamp", ""),
                            }
                        else:
                            # Update timestamp to latest
                            current_timestamp = entry.get("timestamp", "")
                            if current_timestamp > sessions[session_id]["timestamp"]:
                                sessions[session_id]["timestamp"] = current_timestamp

                        if entry_type == "user" and not sessions[session_id]["firstUserMessage"]:
                            message = entry.get("message", {})
                            content = message.get("content", [])
                            first_msg = get_first_user_message(content)
                            if first_msg:
                                sessions[session_id]["firstUserMessage"] = first_msg

                except (json.JSONDecodeError, Exception):
                    pass

    except Exception as e:
        logging.warning(f"Error reading {file_path}: {e}")


def get_worker_sessions() -> list[dict]:
    """
    Get worker sessions for the default directory.

    Returns:
        List of session dictionaries with sessionId, title, timestamp, and shortId
    """
    # Use default home directory
    current_dir = str(AGENT_MOUNT_FOLDER)
    current_path = Path(current_dir).resolve()
    # Replace /, spaces, and periods with hyphens for Claude project naming
    claude_project_name = re.sub(r"[/. ]", "-", str(current_path))
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    project_dir = get_instance_settings().claude_projects_dir / claude_project_name

    if not project_dir.exists():
        logging.info(f"Claude project not found at {project_dir}")
        return []

    jsonl_files = [f for f in project_dir.glob("*.jsonl") if not f.name.startswith("agent-")]

    if not jsonl_files:
        logging.info("No session files found")
        return []

    sessions = {}
    summaries = {}
    uuid_to_session = {}

    for jsonl_file in jsonl_files:
        parse_jsonl(jsonl_file, sessions, summaries, uuid_to_session)

    # Link summaries to sessions
    for uuid, summary in summaries.items():
        if uuid in uuid_to_session:
            session_id = uuid_to_session[uuid]
            if session_id in sessions:
                sessions[session_id]["summary"] = summary

    # Sort sessions by timestamp
    sorted_sessions = sorted(sessions.values(), key=lambda x: x["timestamp"], reverse=True)

    # Add title to each session
    for session in sorted_sessions:
        session["title"] = session["summary"] or session["firstUserMessage"] or "(No message)"

    return sorted_sessions

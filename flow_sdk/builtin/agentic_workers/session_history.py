"""
Session history utilities for loading Claude Code session JSONL files.

Converts Claude JSONL format to FlowData for session restoration.
Reuses load_jsonl from system_profile utils.
"""

import json
import logging
from pathlib import Path

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowDataType, FlowElementType


def _load_jsonl(path: Path, limit: int = None) -> list[dict]:
    """Load JSONL file, return list of entries."""
    entries = []
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                for i, line in enumerate(f):
                    if limit and i >= limit:
                        break
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except IOError:
        pass
    return entries


def get_session_jsonl_path(session_id: str, project_path: Path | None = None) -> Path | None:
    """Get the JSONL file path for a session ID.

    Args:
        session_id: The Claude session ID
        project_path: Optional project path. If None, searches all projects.

    Returns:
        Path to JSONL file or None if not found
    """
    claude_home = Path.home() / ".claude"
    projects_dir = claude_home / "projects"

    if not projects_dir.exists():
        return None

    # If project_path provided, check there first
    if project_path:
        jsonl_path = project_path / f"{session_id}.jsonl"
        if jsonl_path.exists():
            return jsonl_path

    # Search all projects for this session
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl_path = project_dir / f"{session_id}.jsonl"
        if jsonl_path.exists():
            return jsonl_path

    return None


def load_session_history(session_id: str) -> list[FlowData]:
    """Load session history as FlowData list.

    Reuses load_jsonl from system_profile utils.
    Converts Claude JSONL format to FlowData.

    Args:
        session_id: The Claude session ID

    Returns:
        List of FlowData items representing the session history
    """
    jsonl_path = get_session_jsonl_path(session_id)
    if not jsonl_path:
        logging.warning(f"[load_session_history] no JSONL file found for session {session_id}")
        return []

    entries = _load_jsonl(jsonl_path)
    history = []

    import uuid as _uuid

    for entry in entries:
        entry_type = entry.get("type")

        if entry_type == "user":
            message = entry.get("message", {})
            content = message.get("content", [])
            text = _extract_text_content(content)
            if text:
                history.append(
                    FlowData(
                        flow_value=text,
                        attributes={
                            "element-type": FlowElementType.USER_MESSAGE,
                            "data-type": FlowDataType.TEXT,
                            "role": "user",
                            "complete": "true",
                            "group-id": str(_uuid.uuid4()),
                        },
                    )
                )

        elif entry_type == "assistant":
            message = entry.get("message", {})
            content = message.get("content", [])

            for block in content:
                if isinstance(block, dict):
                    block_type = block.get("type")

                    if block_type == "text":
                        text = block.get("text", "")
                        if text:
                            history.append(
                                FlowData(
                                    flow_value=text,
                                    attributes={
                                        "element-type": FlowElementType.CHAT,
                                        "data-type": FlowDataType.TEXT,
                                        "role": "assistant",
                                        "complete": "true",
                                        "group-id": str(_uuid.uuid4()),
                                    },
                                )
                            )

                    elif block_type == "thinking":
                        thinking = block.get("thinking", "")
                        if thinking:
                            history.append(
                                FlowData(
                                    flow_value=thinking,
                                    attributes={
                                        "element-type": FlowElementType.REASONING,
                                        "data-type": FlowDataType.TEXT,
                                        "complete": "true",
                                        "group-id": str(_uuid.uuid4()),
                                    },
                                )
                            )

                    elif block_type == "tool_use":
                        history.append(
                            FlowData(
                                flow_value={
                                    "tool_name": block.get("name"),
                                    "tool_call_id": block.get("id"),
                                    "args": block.get("input"),
                                },
                                attributes={
                                    "element-type": FlowElementType.TOOL_CALL,
                                    "data-type": FlowDataType.OBJECT,
                                    "tool-name": block.get("name", ""),
                                    "complete": "true",
                                    "group-id": str(_uuid.uuid4()),
                                },
                            )
                        )

                    elif block_type == "tool_result":
                        history.append(
                            FlowData(
                                flow_value={
                                    "tool_call_id": block.get("tool_use_id"),
                                    "content": block.get("content"),
                                },
                                attributes={
                                    "element-type": FlowElementType.TOOL_RESULT,
                                    "data-type": FlowDataType.OBJECT,
                                    "complete": "true",
                                    "group-id": str(_uuid.uuid4()),
                                },
                            )
                        )

    return history


def _extract_text_content(content) -> str:
    """Extract text from Claude message content.

    Args:
        content: Message content (string or list of content blocks)

    Returns:
        Extracted text as string
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                texts.append(item.get("text", ""))
            elif isinstance(item, str):
                texts.append(item)
        return "\n".join(texts)
    return ""

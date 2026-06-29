"""MCP tool implementations for flow_sdk."""

import json


def flow_ping() -> str:
    """Health check — returns SDK version and confirms connectivity."""
    from flow_sdk import __version__
    from flow_sdk.discovery.notify import send_mcp_event

    result = f"flow_sdk {__version__} connected"
    send_mcp_event("flow_ping", "", {}, result)
    return result


def flow_entity_crud(claude_session_id: str, crud: str, entity_json: str) -> str:
    """Perform a CRUD operation on a flow entity record.

    Call this whenever you create, read, update, or delete a flow entity
    (skill, task, rule, artifact, session, etc.).

    Args:
        claude_session_id: The session ID (provided in context at session start).
        crud: The operation — "create", "read", "update", or "delete".
        entity_json: JSON string with at least a "type" field, plus "id" for
            read/update/delete.

    Returns:
        Result message string.
    """
    from flow_sdk.utils.log import skill_log

    skill_log(f"MCP entity_crud: {crud} | session={claude_session_id}")
    if not claude_session_id:
        skill_log("MCP entity_crud ERROR: empty session ID")
        return "Error: session ID is required"
    try:
        entity_dict = json.loads(entity_json)
    except json.JSONDecodeError as e:
        skill_log(f"MCP entity_crud ERROR: invalid JSON for entity - {e} {entity_json}")
        return f"Error: invalid JSON — {e}"

    try:
        from plugin_records.skillit_records import skillit_records
    except ImportError:
        return f"entity_crud {crud} received for {entity_dict.get('type', '?')} (plugin_records not available)"

    result = skillit_records.entity_crud(
        session_id=claude_session_id,
        crud=crud,
        entity=entity_dict,
    )
    from flow_sdk.discovery.notify import send_mcp_event
    send_mcp_event("flow_entity_crud", claude_session_id, {"crud": crud, "type": entity_dict.get("type", "?")}, result)
    return result


def flow_tag(flow_tag_xml: str, claude_session_id: str = None) -> str:
    """Call this whenever you encounter a <flow-[type]> tag in the flow XML. The outer xml of the tag will be passed as flow_tag_xml.

    Use this to report progress. Event types include:
    - started_generating_skill
    - skill_ready

    Args:
        flow_tag_xml: The outer XML string of the flow tag.
        claude_session_id: The session ID (provided in context at session start).

    Returns:
        Confirmation string with the received flow tag.
    """
    from flow_sdk.discovery.notify import send_flow_tag, xml_str_to_flow_data_dict
    from flow_sdk.utils.log import skill_log

    skill_log(f"MCP Received flow tag: {flow_tag_xml}")

    try:
        flow_data = xml_str_to_flow_data_dict(flow_tag_xml)
    except (ValueError, Exception) as e:
        skill_log(f"MCP flow tag parse error: {e}")
        return f"Error parsing flow tag: {e}"

    skill_log(f"MCP parsed flow data: {flow_data}")

    element_type = flow_data.get('element_type', '')
    if element_type == 'skill_ready' and claude_session_id:
        try:
            from plugin_records.crud_handlers.skill_creation_handler import (
                skill_creation_handler,
            )
            from plugin_records.skillit_records import skillit_records

            session = skillit_records.get_session(claude_session_id)
            if session:
                skill_creation_handler.on_update(
                    claude_session_id, session, "skill", {"status": "new"}
                )
        except ImportError:
            skill_log("plugin_records not available, skipping skill_ready handler")

    success = send_flow_tag(flow_data)

    status = "sent" if success else "skipped (FlowPad unavailable)"
    result = f"Flow tag {flow_data.get('element_type', 'unknown')}: {status}"
    from flow_sdk.discovery.notify import send_mcp_event
    send_mcp_event("flow_tag", claude_session_id or "", {"element_type": flow_data.get("element_type", "?")}, result)
    return result


def flow_context(claude_session_id: str, action: str, key: str, value: str = None) -> str:
    """Manage session-specific context storage using key-value pairs.

    This tool provides persistent storage for each session. All operations require
    the claude_session_id to ensure data isolation between sessions.

    Args:
        claude_session_id: The session ID (provided in context at session start)
        action: Operation to perform - "get" or "set"
        key: The context key to get or set
        value: The value to set (required for "set" action, ignored for "get")

    Returns:
        For "get": The stored value or an error message if key not found
        For "set": Confirmation message

    Examples:
        flow_context(claude_session_id="abc-123", action="set", key="theme", value="dark")
        flow_context(claude_session_id="abc-123", action="get", key="theme")
    """
    from flow_sdk.mcp_server import known_rules_store, session_store
    from flow_sdk.utils.log import skill_log

    if not claude_session_id:
        return "Error: session_id is required"
    if action not in ("get", "set"):
        return f"Error: action must be 'get' or 'set', got '{action}'"
    if not key:
        return "Error: key is required"
    if action == "set" and value is None:
        return "Error: value is required for 'set' action"

    stores = {"known_rules": known_rules_store}
    store = stores.get(key, session_store)

    try:
        if action == "set":
            result = store.set(claude_session_id, key, value)
        else:
            result = store.get(claude_session_id, key)
    except Exception as e:
        skill_log(f"MCP ERROR: {action} context ERROR {e}")
        return f"Error {action}ing context: {e}"

    from flow_sdk.discovery.notify import send_mcp_event
    send_mcp_event("flow_context", claude_session_id, {"action": action, "key": key}, result)
    return result


def workflow_trace(
    claude_session_id: str,
    workflow_name: str,
    phase: str,
    label: str,
    trace_type: str,
    status: str,
    detail: str = "",
) -> str:
    """Report workflow execution progress — steps, conditions, and sub-workflow calls.

    Models a program execution trace for markdown-defined agent workflows.

    ## trace_type="step"  — sequential execution
      status="enter"  → call at the START of each step
      status="done"   → call at the END; put result summary in detail
      status="error"  → call if step fails; put reason in detail
      status="skip"   → call when step is intentionally bypassed; reason in detail

    ## trace_type="condition"  — if/else branching
      label  = the condition expression (e.g. "if file_count > 10")
      status = "true" or "false"
      detail = which branch was taken or why

    ## trace_type="call"  — calling another workflow
      label         = the sub-workflow name (e.g. "e2e-qa")
      status="enter" → invoking the sub-workflow; params in detail
      Use trace_type="return" to report when it comes back.

    ## trace_type="return"  — returning from a sub-workflow call
      label        = the sub-workflow that returned
      status="done"  → returned successfully; result in detail
      status="error" → sub-workflow failed; reason in detail

    Args:
        claude_session_id: Session ID (provided in context at session start).
        workflow_name: Name of the current workflow/skill being executed.
        phase: Job type or major section (e.g. "Feature Planning").
        label: Step name, condition expression, or callee workflow name.
        trace_type: "step" | "condition" | "call" | "return"
        status: Outcome — "enter"|"done"|"error"|"skip" (step/call/return),
                or "true"|"false" (condition).
        detail: Optional result, decision, branch taken, or error reason.

    Returns:
        Confirmation string.
    """
    from flow_sdk.discovery.notify import send_log_event

    valid_trace_types = ("step", "condition", "call", "return")
    if trace_type not in valid_trace_types:
        return f"Error: trace_type must be one of {valid_trace_types}"

    send_log_event("workflow_trace", {
        "session_id": claude_session_id,
        "workflow_name": workflow_name,
        "phase": phase,
        "label": label,
        "trace_type": trace_type,
        "status": status,
        "detail": detail,
    })

    icons = {
        ("step", "enter"): "▶",
        ("step", "done"): "✓",
        ("step", "error"): "✗",
        ("step", "skip"): "⊘",
        ("condition", "true"): "⊤",
        ("condition", "false"): "⊥",
        ("call", "enter"): "→",
        ("return", "done"): "←",
        ("return", "error"): "↩✗",
    }
    icon = icons.get((trace_type, status), "·")
    return f"{icon} [{workflow_name}/{phase}] {trace_type}({label}): {status}"


def session_analysis(claude_session_id: str, index: int) -> str:
    """This returns a summary of session for analysis.

    Args:
        claude_session_id: The session ID (provided in context at session start)
        index: index of specific entry in session for details on that entry. If index is -1, it returns the summary of the whole session.

    Returns:
        Details of the sessions as a string for the complete session or a specific entry based on the index provided.
    """
    from flow_sdk.transcript_analyzer import AgentTranscriptFile, worker_summary_log  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    if not claude_session_id:
        return "Error: session_id is required"
    if not isinstance(index, int):
        return "Error: index must be an integer"

    # Find <projects_dir>/<encoded>/<session_id>.jsonl across all project dirs.
    projects_dir = get_instance_settings().claude_projects_dir
    jsonl_path = None
    if projects_dir.is_dir():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            cand = project_dir / f"{claude_session_id}.jsonl"
            if cand.is_file():
                jsonl_path = cand
                break
    if jsonl_path is None:
        return f"Error: session {claude_session_id} not found"

    # Worker-generic transcript analyzer: extractive whole-session summary for
    # index == -1, or the full rich rendering of a single entry otherwise.
    if index == -1:
        result = worker_summary_log(jsonl_path, "claude")
    else:
        entries = AgentTranscriptFile("claude", jsonl_path).entries
        if 0 <= index < len(entries):
            result = entries[index].to_string()
        else:
            result = f"Error: index {index} out of range for session with {len(entries)} entries"

    from flow_sdk.discovery.notify import send_mcp_event
    send_mcp_event("session_analysis", claude_session_id, {"index": index}, result[:200])
    return result

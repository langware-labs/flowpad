"""Notification gateway for FlowPad server communication.

Single entry point for all FlowPad server notifications.
Handles service discovery, webhook sending, and rate limiting.
"""

import html
import json
import logging
import os
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
from typing import Optional

from flow_sdk.discovery.flowpad_discovery import (
    discover_all_flowpads,
    is_webhook_rate_limited,
    record_webhook_failure,
)
from flow_sdk.fs_store import RecordType, RefType, ResourceType, SyncOperation
from flow_sdk.utils.environment import get_execution_scope

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Service discovery
# ---------------------------------------------------------------------------

def get_flowpad_status() -> str:
    """Get current Flowpad status.

    Returns:
        One of FlowpadStatus constants: RUNNING, INSTALLED_NOT_RUNNING, NOT_INSTALLED.
    """
    from flow_sdk.discovery.flowpad_discovery import discover_flowpad
    return discover_flowpad().status


def _get_report_urls() -> list[str]:
    """Discover all running Flowpad servers and return their webhook URLs.

    Returns:
        List of webhook URLs for all running servers (prod + dev).
    """
    return [
        r.server_info.url
        for r in discover_all_flowpads()
        if r.server_info
    ]


# ---------------------------------------------------------------------------
# Low-level transport
# ---------------------------------------------------------------------------

def _send_fire_and_forget(url: str, data: bytes, log_context: str, wait: bool = False) -> None:
    """Send HTTP POST in a detached subprocess that survives parent exit.

    Args:
        url: Target URL for the POST request.
        data: JSON-encoded bytes to send.
        log_context: Context string for logging.
        wait: If True, block until the subprocess finishes (for long-running callers
              like the MCP server where ordering matters). Defaults to False for
              hook handlers that must return quickly.
    """
    script = (
        "import urllib.request, sys; "
        "req = urllib.request.Request(sys.argv[1], data=sys.stdin.buffer.read(), "
        "headers={'Content-Type': 'application/json'}, method='POST'); "
        "urllib.request.urlopen(req, timeout=10)"
    )
    try:
        kwargs = {}
        if not wait:
            if sys.platform == "win32":
                CREATE_NO_WINDOW = 0x08000000
                CREATE_NEW_PROCESS_GROUP = 0x00000200
                kwargs["creationflags"] = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
            else:
                kwargs["start_new_session"] = True
        proc = subprocess.Popen(
            [sys.executable, "-c", script, url],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
        proc.stdin.write(data)
        proc.stdin.close()
        if wait:
            proc.wait(timeout=5)
        logger.debug(f"Notification dispatched to {url}:\n {log_context}")
    except Exception as e:
        logger.debug(f"Failed to dispatch notification: {e}")
        record_webhook_failure()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def xml_str_to_flow_data_dict(xml_str: str) -> dict:
    """Parse a flow-* XML string into a flow-data-compatible dict.

    Extracts minimal fields: element_type, index, created_time, data_type, flow_value.

    Args:
        xml_str: XML string like '<flow-{type} attr="val">content</flow-{type}>'

    Returns:
        Dict with element_type, data_type, flow_value, and optional index/created_time.

    Raises:
        ValueError: If xml_str contains no flow-* element.
    """
    root = ET.fromstring(xml_str)
    tag = root.tag

    if not tag.startswith("flow-"):
        raise ValueError(f"Expected a flow-* element, got <{tag}>")

    element_type = tag[5:]

    attribs = dict(root.attrib)
    data_type = attribs.get("data-type", "string")

    # Content is the text inside the element
    content = root.text or ""

    # Parse flow_value based on data_type
    if data_type in ("object", "json", "entity") and content.strip():
        try:
            flow_value = json.loads(html.unescape(content))
        except (json.JSONDecodeError, ValueError):
            flow_value = html.unescape(content)
    else:
        flow_value = html.unescape(content) if content else ""

    result = {
        "element_type": element_type,
        "data_type": data_type,
        "flow_value": flow_value,
    }

    if "i" in attribs:
        result["index"] = int(attribs["i"])
    if "t" in attribs:
        result["created_time"] = attribs["t"]

    return result


# ---------------------------------------------------------------------------
# Core resource sync sender
# ---------------------------------------------------------------------------

def send_resource_sync(
    type: str,
    id: str,
    operation: SyncOperation,
    data: dict | str,
    resource_type: ResourceType = ResourceType.ENTITY,
    ref_type: RefType = RefType.DATA,
    log_context: str = "",
    wait: bool = False,
) -> bool:
    """Send a resource sync event to FlowPad (fire-and-forget).

    All notifications flow through this single envelope format.

    Args:
        type: Entity type (e.g. "task") or relationship kind (e.g. "child").
        id: Unique identifier for the resource or event.
        operation: create / update / delete / event.
        data: Resource payload (CRUD) or event payload (EVENT).
        resource_type: Whether this sync is for an entity or a relationship.
        ref_type: Whether data is inline ("data") or a path reference ("path").
        log_context: Context string for logging.
        wait: If True, block until the subprocess finishes.

    Returns:
        True if notification was queued, False if skipped.
    """
    if is_webhook_rate_limited():
        logger.warning(f"[notify] SKIPPED: rate-limited ({log_context})")
        return False

    ctx = log_context or f"{type}/{operation}"
    urls = _get_report_urls()
    logger.warning(f"[notify] urls={urls} type={type} op={operation} ctx={ctx}")
    if not urls:
        logger.warning(f"[notify] SKIPPED: no webhook urls (Flowpad discovery returned empty) ({ctx})")
        return False

    payload = {
        "webhook_type": "hook_op",
        "webhook_payload": {
            "resource_type": str(resource_type),
            "type": type,
            "id": id,
            "operation": str(operation),
            "ref_type": str(ref_type),
            "data": data,
            "execution_scope": get_execution_scope(),
        },
    }

    raw = json.dumps(payload).encode("utf-8")
    for url in urls:
        _send_fire_and_forget(url, raw, ctx, wait=wait)
    return True


# ---------------------------------------------------------------------------
# Typed convenience senders
# ---------------------------------------------------------------------------

def send_log_event(event_type: str, context: dict | str = None) -> bool:
    """Send a log event to FlowPad (fire-and-forget).

    Args:
        event_type: Type of event (e.g., "skill_matched", "hook_triggered").
        context: Optional additional context.

    Returns:
        True if notification was queued, False if Flowpad not running.
    """
    return send_resource_sync(
        type=RecordType.LOG,
        id=str(uuid.uuid4()),
        operation=SyncOperation.EVENT,
        data={
            "event_name": event_type,
            "event_data": context or {},
        },
        log_context=f"log={event_type}",
    )


def send_entity_sync(
    operation: SyncOperation,
    data: dict,
    resource_type: ResourceType = ResourceType.ENTITY,
    wait: bool = False,
) -> bool:
    """Send an entity or relationship CRUD sync to FlowPad.

    Extracts ``type`` and ``id`` from the data dict automatically.

    Args:
        operation: SyncOperation.CREATE / UPDATE / DELETE.
        data: Full ResourceRecord dict (must contain "type" and "id").
        resource_type: ENTITY (default) or RELATIONSHIP.
        wait: If True, block until the subprocess finishes.

    Returns:
        True if notification was queued, False if Flowpad not running.
    """
    entity_type = data.get("type", "unknown")
    entity_id = data.get("id", str(uuid.uuid4()))
    return send_resource_sync(
        type=entity_type,
        id=entity_id,
        operation=operation,
        data=data,
        resource_type=resource_type,
        log_context=f"{entity_type} {operation} id={entity_id}",
        wait=wait,
    )


def send_mcp_event(tool_name: str, session_id: str, params: dict, result: str) -> bool:
    """Send an MCP tool call event to FlowPad (fire-and-forget).

    Args:
        tool_name: Name of the MCP tool called (e.g. "flow_ping").
        session_id: The claude_session_id (empty string if not applicable).
        params: Dict of tool input parameters.
        result: The result string returned by the tool.

    Returns:
        True if notification was queued, False if Flowpad not running.
    """
    return send_resource_sync(
        type=RecordType.LOG,
        id=str(uuid.uuid4()),
        operation=SyncOperation.EVENT,
        data={
            "event_name": "mcp_tool_call",
            "event_data": {
                "tool": tool_name,
                "session_id": session_id,
                "params": params,
                "result": result,
            },
        },
        log_context=f"mcp={tool_name}",
        wait=True,
    )


def send_flow_tag(flow_data: dict) -> bool:
    """Send a flow tag event to FlowPad.

    Args:
        flow_data: Parsed flow tag dict (from xml_str_to_flow_data_dict).

    Returns:
        True if notification was queued, False if Flowpad not running.
    """
    return send_resource_sync(
        type=RecordType.SKILL,
        id=str(uuid.uuid4()),
        operation=SyncOperation.EVENT,
        data={
            "event_name": "flow_tag",
            "event_data": flow_data,
        },
        log_context=f"flow_tag={flow_data.get('element_type', 'unknown')}",
    )

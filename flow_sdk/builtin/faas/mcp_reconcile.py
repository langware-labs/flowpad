"""Read-only reconciliation: indexed MCP servers vs disk vs the live CLI.

Answers "are the MCP servers FlowPad indexed the same as what's really on this
machine?" by diffing three views of the same world:

  - **disk**  — the indexer's own walk of every config file (the FS truth that
    feeds the MCP_SERVER records). Reuses ``_walk_type_records`` so it is
    byte-for-byte what indexing produces.
  - **cli**   — ``claude mcp list`` output (optional, ``use_cli=True``). This is
    the ONLY view that reflects live/remote state — e.g. the claude.ai cloud
    connectors, whose on-disk form is name-only.

This lives OUTSIDE the indexer on purpose: index functions are a pure
read-only disk walk and must never shell out. The CLI call happens here, in an
on-demand action, guarded by ``shutil.which`` and fail-soft.
"""

from __future__ import annotations

import asyncio
import re
import shutil
import subprocess

# `claude mcp list` rows look like:
#   "<name>: <launch> - ✔ Connected"   /   "<name>: <launch> - �’ Failed to connect"
# Capture the name and the launch line; tolerate the trailing " - <status>".
_CLI_ROW = re.compile(r"^(?P<name>[^:]+):\s*(?P<launch>.*?)(?:\s+-\s+[^-]*)?$")

# Hard cap on the CLI probe (user-approved, mirrors the capability env-probe).
_CLI_TIMEOUT_SECONDS = 10.0


def _normalize_name(name: str) -> str:
    """Loose key for matching a disk record against a CLI row by name."""
    return name.strip().lower()


def _disk_summary(item: dict) -> dict:
    """Project a walked MCP_SERVER dict to the fields the diff compares on."""
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "worker_type": item.get("worker_type"),
        "connector_type": item.get("connector_type"),
        "transport": item.get("transport"),
        "command": item.get("command") or "",
        "url": item.get("url") or "",
        "scope": item.get("scope"),
        "source_file": item.get("source_file"),
    }


async def _walk_disk(scoped_roots) -> list[dict]:
    """The indexer's MCP_SERVER walk over ``scoped_roots`` (the disk truth)."""
    from flow_sdk.builtin.faas.scan_indexer import _walk_type_records
    from flow_sdk.schema.types import EntityType

    items = await _walk_type_records(
        EntityType.MCP_SERVER, scoped_roots, "mcp_server", "mcp_server"
    )
    return [_disk_summary(i) for i in items]


def _parse_cli_list(text: str) -> list[dict]:
    """Parse ``claude mcp list`` stdout into ``[{name, launch}]`` rows."""
    rows: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or ":" not in line or line.lower().startswith("checking"):
            continue
        m = _CLI_ROW.match(line)
        if not m:
            continue
        name = m.group("name").strip()
        launch = m.group("launch").strip()
        if name and launch:
            rows.append({"name": name, "launch": launch})
    return rows


async def _list_cli_servers() -> dict:
    """Run ``claude mcp list``; fail-soft to a status marker (never raises)."""
    exe = shutil.which("claude")
    if not exe:
        return {"available": False, "reason": "cli_unavailable", "servers": []}
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            [exe, "mcp", "list"],
            capture_output=True,
            text=True,
            timeout=_CLI_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": "cli_timeout", "servers": []}
    except Exception as exc:  # noqa: BLE001 — read-only probe, surface the reason
        return {"available": False, "reason": f"cli_error: {exc}", "servers": []}
    text = proc.stdout or proc.stderr or ""
    return {"available": True, "reason": None, "servers": _parse_cli_list(text)}


async def reconcile_mcp_servers(scoped_roots, *, use_cli: bool = False) -> dict:
    """Diff indexed/disk MCP servers against the live CLI list.

    Matching is by normalized server name (disk may hold many per-(file,scope)
    definitions of one name; they collapse to a single name key here).
    """
    disk = await _walk_disk(scoped_roots)
    disk_by_name: dict[str, list[dict]] = {}
    for d in disk:
        disk_by_name.setdefault(_normalize_name(d.get("name") or ""), []).append(d)

    result: dict = {
        "disk": disk,
        "disk_count": len(disk),
        "disk_unique_names": sorted(disk_by_name),
    }

    if not use_cli:
        return result

    cli = await _list_cli_servers()
    result["cli"] = cli
    if not cli["available"]:
        return result

    cli_by_name = {_normalize_name(s["name"]): s for s in cli["servers"]}
    disk_names = set(disk_by_name)
    cli_names = set(cli_by_name)

    result["only_on_disk"] = sorted(disk_names - cli_names)
    result["only_in_cli"] = sorted(
        cli_by_name[n]["name"] for n in (cli_names - disk_names)
    )
    result["in_both"] = sorted(disk_names & cli_names)
    return result

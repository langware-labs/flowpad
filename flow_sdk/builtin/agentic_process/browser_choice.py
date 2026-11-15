"""Which browser a session uses — one rule, read at every launch.

Session override (``context_data["browser"]``) > the legacy ``chrome`` flag (a caller
that asked for ``--chrome``) > the project's ``browser`` in ``project_manifest.json``
> ``agent``. A harness whose driver has no extension always gets ``agent``.

``agent`` attaches ONE MCP server, ``browser`` (``flow_sdk/core/agent_browser.py``);
``extension`` passes ``--chrome`` and attaches no browser server.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Optional

from flow_sdk.schema.data_spec.project_manifest_spec import BROWSERS

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

Browser = Literal["agent", "extension"]

#: Tool-name prefixes that mean "drove a browser", per family.
_FAMILIES = {
    "mcp__claude-in-chrome__": "extension",
    "mcp__browser__": "agent",
    "mcp__playwright__": "playwright",
    "mcp__debugMcp__": "playwright",
    "mcp__chrome-devtools__": "playwright",
}


def resolve(*, override: object, legacy_chrome: bool, project_browser: str, supports_extension: bool) -> Browser:
    """The pure rule — see the module docstring."""
    if not supports_extension:
        return "agent"
    if override in BROWSERS:
        return override  # type: ignore[return-value]
    if legacy_chrome:
        return "extension"
    return project_browser if project_browser in BROWSERS else "agent"  # type: ignore[return-value]


def supports_extension(process: "AgenticProcess") -> bool:
    return bool(process.driver.supports_browser_extension())


async def resolve_for(process: "AgenticProcess", project_browser: Optional[str] = None) -> Browser:
    """``project_browser``: the project's setting when the caller already read it."""
    if project_browser is None:
        from flow_sdk.assets.project_manifest import read_browser  # noqa: PLC0415
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(process.project_id) if process.project_id else None
        mount = project.fs_storage_mount_path if project is not None else None
        root = mount or process.workdir
        project_browser = read_browser(Path(root)) if root else "agent"
    return resolve(
        override=(process.context_data or {}).get("browser"),
        legacy_chrome=bool((process.cli_config or {}).get("chrome")),
        project_browser=project_browser,
        supports_extension=supports_extension(process),
    )


def extension_hint() -> dict:
    """What Claude Code last recorded about the extension (``~/.claude.json``). A hint:
    the live answer is only known inside a session, on its next browser call."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    try:
        data = json.loads((get_instance_settings().user_home / ".claude.json").read_text())
    except (OSError, ValueError):
        return {"installed": False, "device": ""}
    return {
        "installed": bool(data.get("cachedChromeExtensionInstalled")),
        "device": str((data.get("chromeExtension") or {}).get("pairedDeviceName") or ""),
    }


def _use(family: str, tool: str, args: object, at: object, failed: bool) -> dict:
    url = args.get("url", "") if isinstance(args, dict) else ""
    return {"family": family, "tool": tool, "url": url or "", "at": at, "failed": failed}


def last_browser_use(transcript: Optional[Path], tail_bytes: int = 400_000) -> Optional[dict]:
    """The session's last browser tool call: ``{family, tool, url, at, failed}``. Reads the
    transcript's tail only — a session's last call is near its end."""
    if transcript is None or not transcript.exists():
        return None
    with transcript.open("rb") as fh:
        fh.seek(max(0, transcript.stat().st_size - tail_bytes))
        lines = fh.read().decode("utf-8", "replace").splitlines()
    pending: dict[str, dict] = {}
    last: Optional[dict] = None
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        item = row.get("item")
        if isinstance(item, dict) and item.get("type") == "mcp_tool_call":
            # A finished call with server and tool apart (the Codex stream).
            family = _FAMILIES.get(f"mcp__{item.get('server')}__")
            if family:
                failed = bool(item.get("error")) or item.get("status") == "failed"
                last = _use(family, str(item.get("tool") or ""), item.get("arguments"), row.get("timestamp"), failed)
            continue
        content = (row.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else ():
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                name = str(block.get("name") or "")
                family = next((f for p, f in _FAMILIES.items() if name.startswith(p)), None)
                if family:
                    last = _use(family, name.rsplit("__", 1)[-1], block.get("input"), row.get("timestamp"), False)
                    pending[block.get("id", "")] = last
            elif block.get("type") == "tool_result" and block.get("tool_use_id") in pending:
                pending.pop(block["tool_use_id"])["failed"] = bool(block.get("is_error"))
    if last is not None and not last["at"]:
        # A record with no clock: the transcript's own write time stands in.
        last["at"] = datetime.fromtimestamp(transcript.stat().st_mtime, tz=timezone.utc).isoformat()
    return last

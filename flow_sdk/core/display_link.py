"""Interpret a clicked reference, then delegate to the shared display resolver.

Only activation reaches this module. Detection never stats files or indexes assets.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

from flow_sdk.core.display_target import (
    DisplayTargetKind,
    DisplayTargetNotFound,
    InvalidDisplayTarget,
    resolve_display_target,
)
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.type_id import TypeId


async def resolve_display_link(link: str, *, source: Entity | None, discover: bool) -> dict:
    raw = link.strip()
    if not raw or "\x00" in raw:
        raise InvalidDisplayTarget("Missing or invalid link")

    if raw.startswith(("/dock/", "/win/", "/dev/")):
        from flow_sdk.core.dock_address import parse_dock_url

        address = parse_dock_url(raw)
        if address is None:
            raise InvalidDisplayTarget("Invalid dock link")
        # dock_target performs the existence and view validation too.
        from flow_sdk.core.dock_address import dock_url

        result = await resolve_display_target(dock=dock_url(
            address.view_type, pointer=address.pointer, options=address.options, page=address.page,
        ).removeprefix("/dock/"))
        return result

    # A Windows drive is a path, not a URI scheme.
    uri = urlsplit(raw) if not re.match(r"^[A-Za-z]:[/\\]", raw) else None
    if uri and uri.scheme in ("http", "https"):
        if not uri.hostname:
            raise InvalidDisplayTarget("URL needs a hostname")
        return {"kind": DisplayTargetKind.URL, "url": raw}
    if uri and uri.scheme == "file":
        if uri.netloc not in ("", "localhost"):
            raise InvalidDisplayTarget("Only local file URLs are supported")
        raw = unquote(uri.path)
        if re.match(r"^/[A-Za-z]:/", raw):
            raw = raw[1:]
    elif uri and uri.scheme:
        # file.py:12 is a source position, not a URI scheme.
        if not re.search(r":\d+(?::\d+)?$", raw):
            raise InvalidDisplayTarget(f"Unsupported link protocol: {uri.scheme}")

    position = re.search(r"(?::(?P<line>\d+)(?::(?P<column>\d+))?|#L(?P<fragment>\d+))$", raw)
    options = {}
    if position:
        raw = raw[:position.start()]
        options["line"] = int(position["line"] or position["fragment"])
        if position["column"]:
            options["column"] = int(position["column"])
        if any(value < 1 for value in options.values()):
            raise InvalidDisplayTarget("Source positions start at 1")

    # Use the existing TypeId grammar, including named references.
    if "/" not in raw and "\\" not in raw:
        try:
            tid = TypeId(raw)
        except (ValueError, IndexError):
            tid = None
        if tid and tid.id:
            return {**await resolve_display_target(typeid=raw), **options}

    if source is not None and getattr(source, "compute_node_id", None):
        from flow_sdk.builtin.faas.compute_node import ComputeNode
        from flow_sdk.config import ComputeProviderType

        node = await ComputeNode.get_by_id(source.compute_node_id)
        if node is None or node.node_provider_type != ComputeProviderType.LOCAL_MACHINE:
            raise InvalidDisplayTarget("File links on remote terminals are not supported yet")

    path = Path(raw).expanduser()
    if not path.is_absolute():
        bases = [getattr(source, "workdir", None), getattr(source, "fs_storage_mount_path", None)]
        project_id = getattr(source, "project_id", None)
        if project_id:
            from flow_sdk.builtin.project import Project

            project = await Project.get_by_id(project_id)
            bases.append(project.fs_storage_mount_path if project else None)
        candidates = [Path(base) / path for base in dict.fromkeys(bases) if base]
        path = next((candidate for candidate in candidates if candidate.exists()), None)
        if path is None:
            raise DisplayTargetNotFound(f"File not found in this session or project: {raw}")
    if not path.exists():
        raise DisplayTargetNotFound(f"File not found: {raw}")
    target = await resolve_display_target(path=str(path.resolve()), discover=discover)
    if path.is_dir() and target["kind"] == DisplayTargetKind.VFS:
        raise InvalidDisplayTarget("This directory is not a registered asset")
    return {**target, **options}

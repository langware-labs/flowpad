"""Project/context navigation over the shared filesystem asset catalog.

Project relationships and navigator shape belong here. Asset enumeration and
occurrence attribution come from SDK utilities, including unindexed files.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel

from flow_sdk.assets.menu import asset_counts, menu_count_types


def _native_path(value: str) -> str:
    return str(Path(value).expanduser().resolve()) if value else ""

if TYPE_CHECKING:  # pragma: no cover - typing only
    from flow_sdk.assets.catalog import AssetSource
    from flow_sdk.builtin.project import Project

log = logging.getLogger(__name__)

# Upper bound on the single asset scan that feeds every node's counters. Counts
# are a floor once this trips (``truncated``), never silently wrong.
MENU_SCAN_CAP = 20_000

# Hard ceiling on DFS depth, independent of the visited-set cycle guard: the
# visited set terminates cycles but not a pathological 200-deep legitimate
# chain, and a depth cap alone would not stop a diamond from re-expanding.
MAX_MENU_DEPTH = 16


class BrowsingOptions(BaseModel):
    """Options for the menu form of ``project/{id}/get-assets``.

    ``assets`` exists so a menu-only caller can skip the flat descriptor scan
    (plus its remote-hydration round trip) it would otherwise pay for and throw
    away. It defaults to True, so every existing caller is byte-identical.

    Bound from query params on a GET (``routes/graph.py`` validates any
    ``BaseModel`` action param against ``json_data + request_params``), so
    ``?menu=true&max_depth=3`` needs no routing change. Absent ⇒ defaults ⇒ the
    action's response is byte-identical to what it returned before this existed.

    Deliberately carries no ``auto_index``: that would write. Deliberately
    carries no ``types``/``limit`` either — those are already flat params on the
    action, and duplicating them creates a precedence question with no right
    answer.
    """

    menu: bool = False
    assets: bool = True
    recursive: bool = True
    max_depth: int = 8


@dataclass
class MenuGroup:
    """One per-type row of a node's menu.

    ``own_count`` is what lives under this node's own directory; ``count`` is
    that plus every descendant's, so a collapsed parent row shows the total.

    Counts only. Icon, label, and view-mode tier are NOT shipped: the client
    already holds the whole type registry synchronously from bootstrap, so
    re-sending per-type metadata on every menu response would be a second,
    staler copy of data it can look up by ``type_name``.
    """

    type_name: str
    own_count: int
    count: int

    def to_row(self) -> dict:
        return {"type_name": self.type_name, "own_count": self.own_count, "count": self.count}


@dataclass
class MenuNode:
    """One directory in the menu: the project's own mount, or a context folder.

    A context folder that is itself a Project carries ``project_id`` and was
    recursed into; one that is not is a leaf with its own counts (its assets are
    still reachable, because attribution is by path, not by project stamp).
    """

    path: str
    name: str
    source: "AssetSource"
    depth: int
    project_id: str | None = None
    folder_typeid: str | None = None
    origin_kind: str | None = None
    never_indexed: bool | None = None
    groups: list[MenuGroup] = field(default_factory=list)
    children: list["MenuNode"] = field(default_factory=list)

    def to_row(self) -> dict:
        """The SINGLE owner of this node's wire shape, recursing into children.

        Same rule as ``AssetDescriptor.to_row``: one method owns the row so no
        two consumers can drift.
        """
        return {
            "path": self.path,
            "name": self.name,
            "source": self.source.value,
            "depth": self.depth,
            "project_id": self.project_id,
            "is_project": self.project_id is not None,
            "folder_typeid": self.folder_typeid,
            "origin_kind": self.origin_kind,
            "never_indexed": self.never_indexed,
            "groups": [g.to_row() for g in self.groups],
            "children": [c.to_row() for c in self.children],
        }


@dataclass
class AssetMenu:
    root: MenuNode
    truncated: bool = False

    def to_row(self) -> dict:
        return {"root": self.root.to_row(), "truncated": self.truncated}




def _basename(path: str) -> str:
    trimmed = (path or "").rstrip("/")
    return trimmed.rsplit("/", 1)[-1] if "/" in trimmed else trimmed


async def build_asset_menu(
    project: "Project",
    *,
    types: list[str] | None = None,
    recursive: bool = True,
    max_depth: int = 8,
) -> AssetMenu:
    """Build the menu for ``project`` and, recursively, its context folders.

    Resolve Project relationships once, then enumerate the resulting folders
    through the filesystem catalog. No writes or asset-index queries.
    """
    from flow_sdk.assets.catalog import AssetSource, scan_path_asset_descriptors
    from flow_sdk.builtin.project import Project, mount_key  # noqa: PLC0415
    from flow_sdk.fs_store.indexer import index_log  # noqa: PLC0415

    count_types = menu_count_types(types)
    depth_cap = max(1, min(int(max_depth), MAX_MENU_DEPTH))

    # ── Phase 0: one project read for the whole walk ────────────────────────
    by_mount = await Project.index_by_mount()

    # ── Phase 1: DFS over directories. No I/O per node. ─────────────────────
    visited: set[str] = set()

    def make_node(path: str, source: AssetSource, depth: int, proj: "Project | None", info: dict | None) -> MenuNode:
        pid = str(proj.id) if proj is not None else None
        return MenuNode(
            path=path,
            name=(getattr(proj, "name", None) or _basename(path)) if proj is not None else _basename(path),
            source=source,
            depth=depth,
            project_id=pid,
            folder_typeid=(info or {}).get("typeid") or None,
            origin_kind=(info or {}).get("origin_kind") or None,
            never_indexed=(index_log.project_never_indexed(pid) if pid else None),
        )

    def walk(raw_path: str, source: AssetSource, depth: int, proj: "Project | None", info: dict | None) -> MenuNode | None:
        path = _native_path(raw_path)
        if not path or path in visited:
            # Cycle (C→…→P) and diamond (two parents, one folder) guard. First
            # visit wins, mirroring add_source_dir's canonical-path dedup.
            return None
        visited.add(path)
        node = make_node(path, source, depth, proj, info)
        if not recursive or proj is None or depth >= depth_cap:
            # A folder that is not a Project has no context folders of its own,
            # so the walk stops — but the node still gets counts below.
            return node
        for child_info in getattr(proj, "context_dir_infos", None) or []:
            child_path = _native_path(child_info.get("path") or "")
            if not child_path:
                continue
            child = walk(
                child_path,
                AssetSource.CONTEXT_DIR,
                depth + 1,
                # `mount_key`, not the bare canonical path: `index_by_mount` keys both
                # sides through it, and a trailing-slash mismatch here reads as "no
                # project is mounted at this context folder" — indistinguishable from
                # the real thing. This call site was missed when the rule was introduced.
                by_mount.get(mount_key(child_path)),
                child_info,
            )
            if child is not None:
                node.children.append(child)
        return node

    mount = _native_path(getattr(project, "fs_storage_mount_path", "") or "")
    root = walk(mount, AssetSource.PROJECT_DIR, 0, project, None)
    if root is None:  # no mount path — an empty menu, not an error
        root = MenuNode(path="", name=getattr(project, "name", "") or "", source=AssetSource.PROJECT_DIR, depth=0)
        return AssetMenu(root=root)

    # ── Phase 2: ONE scan for every node ────────────────────────────────────
    nodes: list[MenuNode] = []

    def flatten(node: MenuNode) -> None:
        nodes.append(node)
        for child in node.children:
            flatten(child)

    flatten(root)
    by_dir = {n.path: n for n in nodes}

    descriptors = await scan_path_asset_descriptors(
        [(node.path, node.source) for node in nodes], own_project_id=str(project.id),
        types=count_types, limit=MENU_SCAN_CAP,
    )
    truncated = len(descriptors) >= MENU_SCAN_CAP
    own = asset_counts(descriptors, by_dir)

    # ── Phase 3: post-order accumulation ────────────────────────────────────
    def roll_up(node: MenuNode) -> Counter:
        acc = Counter(own.get(node.path) or {})
        for child in node.children:
            acc.update(roll_up(child))
        mine = own.get(node.path) or Counter()
        node.groups = [MenuGroup(t, mine.get(t, 0), acc[t]) for t in sorted(acc) if acc[t] > 0]
        return acc

    roll_up(root)
    return AssetMenu(root=root, truncated=truncated)

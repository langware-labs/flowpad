"""Agent ``auto_open`` — the tabs a new session as an agent opens with.

``agent.json`` declares them as ``DockPointerSpec`` values (``Tab.pointer`` JSON);
a file is named relative to the agent's project (``vfs/project-<id>/<rel>``) so
the declaration travels with the repo. Opening a session rebases each one onto
this machine and writes the tabs on the backend — the single tab writer — so
every opener (Use, the project home page, auto-launch) gets the same tabs and
the frontend only renders them:

* the FIRST entry is the session's active display (``on_show`` → ``last_shown``,
  which the Vibe landing restores);
* the rest are workspace tabs under the session's own tab (``parent_tab_id``).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from flow_sdk.api.api_types.vfs_path import VFSPath
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.dock_pointer_spec import PROJECT_VFS, DockPointerSpec
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)

LOCAL_COMPUTE_NODE = TypeId(type=EntityType.COMPUTE_NODE.value, id="@local")


@dataclass(frozen=True)
class AutoOpenTab:
    """One declared tab, rebased onto this machine."""

    #: ``Tab.pointer`` JSON as the frontend writes it for this file on this machine.
    pointer: str
    #: The file it shows; ``None`` for a screen (a pointer with no project file).
    path: Optional[Path] = None


def project_ids(entries: list[DockPointerSpec] | None) -> set[str]:
    """The literal project ids the declared files are rooted in."""
    return {found["project"] for spec in entries or [] if (found := PROJECT_VFS.search(spec.pointer))}


def rebase_auto_open(entries: list[DockPointerSpec] | None, *, roots: dict[str, str]) -> list[AutoOpenTab]:
    """Rebase declared tabs onto this machine; drop (and say why) what cannot open here.

    A ``vfs/project-<id>/<rel>`` segment becomes ``vfs/compute_node-@local/<abs>`` —
    the form the editor renders. ``roots`` maps the agent's OWN projects to their
    folders: the declaration names a literal project id, which only resolves where
    the project kept the id it was shared with — any other id is dropped, loudly.
    """
    tabs: list[AutoOpenTab] = []
    for spec in entries or []:
        found = PROJECT_VFS.search(spec.pointer)
        if found is None:
            tabs.append(AutoOpenTab(pointer=spec.to_json()))
            continue
        if found["project"] not in roots:
            logger.warning("auto_open %s names project %s, which this agent does not live in (%s) — dropped",
                           spec.pointer, found["project"], sorted(roots) or "none")
            continue
        base = Path(roots[found["project"]]).resolve()
        path = (base / found["rel"]).resolve()
        if not path.is_relative_to(base) or not path.is_file():
            logger.warning("auto_open %s: no file %s in the project — dropped", spec.pointer, path)
            continue
        local = VFSPath.from_machine_path(str(path), LOCAL_COMPUTE_NODE)
        pointer = f"{spec.pointer[:found.start()]}{found.group(1)}vfs/{local.abs_path}"
        # Plain JSON, not a DockPointerSpec: the rebased pointer names THIS machine,
        # which is exactly what a declared (travelling) pointer is refused for.
        rebased = json.dumps({"viewType": spec.viewType.value, "pointer": pointer}, separators=(",", ":"))
        tabs.append(AutoOpenTab(pointer=rebased, path=path))
    return tabs


async def open_auto_tabs(process: "AgenticProcess", tabs: list[AutoOpenTab]) -> None:
    """Open ``tabs`` for a fresh session: the first as its active display, the rest
    as workspace tabs under the session's own tab."""
    if not tabs:
        return
    from flow_sdk.builtin.tab import broadcast_tabs_changed, ensure_tab  # noqa: PLC0415
    from flow_sdk.core.display_target import dock_target, resolve_display_target  # noqa: PLC0415

    # The session's own tab FIRST: a child whose parent row does not exist yet is
    # orphaned by the next tab-list read (the dangling-parent sweep).
    anchor = await ensure_tab(
        json.dumps({"viewType": "shell", "pointer": f"{process.get_type()}-{process.id}"}, separators=(",", ":")),
        target_type=process.get_type(),
        target_id=str(process.id),
        project_id=process.project_id,
    )
    for tab in tabs[1:]:
        await ensure_tab(tab.pointer, project_id=process.project_id, parent_tab_id=anchor.id)
    first = tabs[0]
    if first.path is not None:
        target = await resolve_display_target(path=str(first.path))
    else:
        address = json.loads(first.pointer)
        target = await dock_target(f"{address['viewType']}/{address['pointer']}")
    await process.on_show(target)
    await broadcast_tabs_changed()

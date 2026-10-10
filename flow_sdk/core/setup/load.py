"""Load an asset: what runs when it is shown here, so it is up by the time its view mounts.

A project's home app, or an app ``flow show`` opens, is LOADED: the display lands on it at once, and this
makes sure there is something to land on. The asset's node is read alone (``ProjectTree.load_one``) and its
``on_load`` wizard is checked — a web app: installed, built, its server answering its health path. Holds:
nothing runs. Does not: the same wizard is started in the background as the node's own setup run
(``start_setup``, same slot and record, so the screen that follows the node's setup follows this, and a
setup already going for the node is joined, never doubled) and its address is answered at once.

The run is a ONE-NODE tree: ``_LoadTree`` hands the walk the node with no prepare, no children and its
``on_load`` as ``run`` — the walker, the record and the screen need no load phase of their own.

Never raises and never blocks on the run: a load that cannot even be judged (no project, a node that will
not derive) answers ``None`` and the view shows what it has. A load never asks — that is ``prepare``'s —
so a load that needs a person stops at a failed node, and the Setup required button says so.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Optional

from flow_sdk.core.setup.tree import SetupNode

logger = logging.getLogger(__name__)


class _LoadTree:
    """A tree of one node: ``node`` as the walk should see it for a load. Holds the two resolvers, nothing else."""

    def __init__(self, node: SetupNode, resolve_op):
        self.node = dataclasses.replace(node, prepare=None, children=(), run=node.on_load)
        self.resolve_op = resolve_op

    async def resolve_node(self, node_id: str) -> Optional[SetupNode]:
        return self.node if node_id == self.node.id else None


async def load_asset(project: Any, asset: Any) -> Optional[str]:
    """Make ``asset`` ready to show here; the address of the run doing it, or ``None`` when nothing runs."""
    try:
        return await _load(project, asset)
    except Exception:  # noqa: BLE001 — a load is an optimisation of the display, never the reason it is blank
        logger.warning("load of %s failed; showing it as it is", getattr(asset, "typeid", asset), exc_info=True)
        return None


async def _load(project: Any, asset: Any) -> Optional[str]:
    from flow_sdk.builtin.project_setup import start_setup  # noqa: PLC0415
    from flow_sdk.core.setup.derive import ProjectTree  # noqa: PLC0415
    from flow_sdk.core.setup.execute import execute_setup  # noqa: PLC0415

    if project is None:
        return None
    node_id = str(asset.typeid)
    tree = await ProjectTree(project).load_one(asset)
    node = await tree.resolve_node(node_id)
    if node is None or node.on_load is None or node.skipped:
        return None
    alone = _LoadTree(node, tree.resolve_op)
    mount = str(getattr(project, "fs_storage_mount_path", "") or "")
    held = await execute_setup(
        node_id, resolve_node=alone.resolve_node, resolve_op=alone.resolve_op, subject_entity=f"project-{project.id}",
        cwd=mount or None, check_only=True, approved=True,
    )
    if held.ok:
        return None
    return await start_setup(project, root=node_id, tree=alone)


__all__ = ["load_asset"]

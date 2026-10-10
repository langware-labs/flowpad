"""Load an asset: what runs the first time it is shown here, so it is up by the time its view mounts.

A project's home app, or an app ``flow show`` opens, is LOADED: the display lands on it at once, and this
makes sure there is something to land on. Three answers, in order of cost:

1. **Warm.** The record is stamped (``setup_loaded``) and its load's check holds — a web app: its
   server answers its health path. One loopback probe; nothing runs.
2. **Up already, unstamped.** The check holds on a first load (the person started the app by hand):
   stamp it, nothing runs.
3. **Not up.** Start the node's load wizard (``on_load``) in the background — the project setup's own run of that node
   (``start_setup``, ``phase="load"``), so the screen that follows the node's setup follows this, and a
   setup already going for the node is joined, never doubled. Answer its address at once; the stamp is
   written when the run reaches its goal.

Never raises and never blocks on the run: a load that cannot even be judged (no project, a tree that will
not build) answers ``None`` and the view shows what it has. A load never asks — that is ``prepare``'s —
so a load that needs a person stops at a failed node, and the Setup required button says so.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

from flow_sdk.schema.data_spec.asset_setup_spec import SetupLoadSpec, SetupTreeResult

logger = logging.getLogger(__name__)


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

    if project is None or not hasattr(asset, "setup_loaded"):
        return None
    node_id = str(asset.typeid)
    if asset.setup_loaded is not None and await _warm(asset):
        return None  # the common path: one probe, and the view has its app

    tree = await ProjectTree(project).load()
    node = await tree.resolve_node(node_id)
    if node is None or node.on_load is None or node.skipped:
        return None
    mount = str(getattr(project, "fs_storage_mount_path", "") or "")
    held = await execute_setup(
        node_id, resolve_node=tree.resolve_node, resolve_op=tree.resolve_op, subject_entity=f"project-{project.id}",
        cwd=mount or None, check_only=True, approved=True, phase="load",
    )
    if held.ok:
        await _stamp(asset, "", "already up")
        return None

    async def stamp(result: SetupTreeResult) -> None:
        if result.ok:
            await _stamp(asset, address, result.detail or "loaded")

    address = await start_setup(project, root=node_id, phase="load", on_done=stamp)
    return address


async def _warm(asset: Any) -> bool:
    """A stamped web app whose server answers now — without building the tree."""
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415

    answer = await webapp_setup.step(str(asset.id), "start", check=True)
    return answer.ok


async def _stamp(asset: Any, run: str, detail: str) -> None:
    from flow_sdk.core.setup.skip_mark import write_setup_load  # noqa: PLC0415

    if asset.setup_loaded is not None:
        return
    await write_setup_load(asset, SetupLoadSpec(at=time.time(), run=run, detail=detail))


__all__ = ["load_asset"]

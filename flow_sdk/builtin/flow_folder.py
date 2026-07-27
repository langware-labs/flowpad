"""The shared folder-document scaffold — ONE copy of the flow-folder contract.

AgenticFlow and Journey are the same on-disk shape (graph.json + display.json +
runs/ + a ``.flow`` id capsule) driven by the same engine; this module owns the
scaffold so the contract can't drift between them. Any future folder-doc type
calls these instead of re-rolling the layout.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.core import Entity

logger = logging.getLogger(__name__)

DISPLAY_STUB = '{"version": 1, "nodes": {}}\n'


def folder_slug(name: str, fallback: str) -> str:
    """Filesystem-safe folder name from an entity name."""
    return (
        "".join(c if c.isalnum() or c in "-_" else "-" for c in (name or fallback)).strip("-")
        or fallback
    )


def scaffold_flow_folder(
    entity: "Entity", home_dir: Path, fallback_slug: str, *, scripts: bool = False
) -> Path:
    """Create the folder + stub files for a fresh folder-doc entity (idempotent).

    Sets ``entity.asset_ref`` to the resolved folder and pins the entity id in
    the ``.flow`` capsule so the indexer adopts it.
    """
    from flow_sdk.flow_manager.flow_doc import empty_flow_doc

    asset_ref = getattr(entity, "asset_ref", "")
    folder = Path(asset_ref) if asset_ref else home_dir / folder_slug(entity.name, fallback_slug)
    folder.mkdir(parents=True, exist_ok=True)
    if scripts:
        (folder / "scripts").mkdir(exist_ok=True)
    (folder / "runs").mkdir(exist_ok=True)
    graph = folder / "graph.json"
    if not graph.exists():
        graph.write_text(empty_flow_doc(entity.id or "", entity.name), encoding="utf-8")
    display = folder / "display.json"
    if not display.exists():
        display.write_text(DISPLAY_STUB, encoding="utf-8")
    if entity.id:
        capsule = folder / ".flow"
        capsule.mkdir(exist_ok=True)
        id_file = capsule / "id"
        if not id_file.exists():
            id_file.write_text(entity.id, encoding="utf-8")
    entity.asset_ref = str(folder)
    return folder


async def rescaffold_after_save(entity: "Entity", label: str) -> None:
    """The post-save scaffold dance shared by every folder-doc entity: ensure
    the folder exists, and re-persist ONLY when the scaffold just minted the
    folder path (fresh entity) — steady-state saves stay a single DB write."""
    try:
        prev_ref = entity.asset_ref
        entity.materialize_folder()
        if entity.asset_ref != prev_ref:
            await entity.update()
    except Exception:
        logger.exception("%s: folder scaffold failed", label)

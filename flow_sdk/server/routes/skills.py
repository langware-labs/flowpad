"""Skills route — skill folder structure and file listings.

Endpoints:
- ``GET /api/v1/skills/{skill_id}/tree`` — recursive folder tree structure
  for a skill folder
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter()


def _build_tree(root: Path) -> dict:
    """Recursively build a tree of files and folders.

    Returns a dict with {name, type, children?} where type is 'file' or
    'directory'. Folders come first, then files, both sorted alphabetically.
    """
    if not root.exists():
        return {"name": root.name, "type": "directory", "children": []}

    if root.is_file():
        return {"name": root.name, "type": "file", "size": root.stat().st_size}

    try:
        children = []
        for child in sorted(root.iterdir()):
            # Skip hidden files/folders
            if child.name.startswith('.'):
                continue
            children.append(_build_tree(child))

        # Sort: folders first, then files, both alphabetically
        children.sort(key=lambda n: (n["type"] == "file", n["name"]))

        return {"name": root.name, "type": "directory", "children": children}
    except OSError as e:
        # Permission denied or other I/O errors
        raise HTTPException(status_code=403, detail=f"Cannot access folder: {e}")


@router.get("/api/v1/skills/{skill_id}/tree")
async def get_skill_tree(skill_id: str):
    """Return the folder tree structure for a skill.

    The skill must exist and have an ``asset_ref`` pointing to its folder.
    Hidden files and folders (starting with `.`) are excluded.
    """
    from flow_sdk.builtin.skill import Skill  # noqa: PLC0415

    skill = await Skill.get_one(id=skill_id)
    if not skill or not skill.asset_ref:
        raise HTTPException(status_code=404, detail=f"Skill {skill_id} not found or has no asset_ref")

    skill_path = Path(skill.asset_ref)
    if not skill_path.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill folder does not exist: {skill_path}")

    tree = _build_tree(skill_path)
    return JSONResponse({"status": "SUCCESS", "data": {"tree": tree}})

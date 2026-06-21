"""``entity.frontmatter`` — read/write access to an asset's YAML frontmatter.

The file frontmatter is the source of truth for asset-level metadata that must
round-trip on disk (e.g. the running ``version``). This accessor reads through
to the file on every ``get`` (the indexer or another writer may have touched it)
and write-through-merges on every ``set`` (preserving the body and all other
keys). It is intentionally backed by the on-disk body file, NOT the entity's
``metadata`` snapshot dict, which can be stale.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from flow_sdk.fs_store.fs_record import write_text_if_changed
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
    merge_frontmatter,
)

if TYPE_CHECKING:
    from flow_sdk.core.entity.entity_model import Entity


class FrontmatterAccessor:
    """Per-access accessor over an entity's main-body frontmatter on disk.

    Constructed fresh by ``Entity.frontmatter`` each access, so it holds no
    long-lived state beyond the resolved body path. ``get``/``__getitem__`` read
    through to disk; ``set``/``__setitem__`` merge-write back, preserving the
    body and unrelated keys.
    """

    def __init__(self, entity: "Entity") -> None:
        self._entity = entity

    def _body_path(self) -> Path | None:
        asset_ref = getattr(self._entity, "asset_ref", None)
        if not asset_ref:
            return None
        asset_path = Path(str(asset_ref)).resolve()
        info = self._entity.type_info
        return info.body_path_for(asset_path) if info else asset_path

    def _read_fields(self) -> dict[str, Any]:
        path = self._body_path()
        if not path or not path.exists():
            return {}
        try:
            fm = _extract_frontmatter(path.read_text(encoding="utf-8"))
        except OSError:
            return {}
        if not fm:
            return {}
        parsed = _yaml_load(fm)
        return parsed if isinstance(parsed, dict) else {}

    def get(self, key: str, default: Any = None) -> Any:
        return self._read_fields().get(key, default)

    def __getitem__(self, key: str) -> Any:
        return self._read_fields()[key]

    def __contains__(self, key: str) -> bool:
        return key in self._read_fields()

    def as_dict(self) -> dict[str, Any]:
        """Snapshot of all frontmatter fields, read fresh from disk."""
        return self._read_fields()

    def set(self, key: str, value: Any) -> "FrontmatterAccessor":
        """Merge ``{key: value}`` into the frontmatter and write through. Chains."""
        path = self._body_path()
        if not path:
            raise ValueError(
                f"Entity {self._entity!r} has no asset_ref body file to write frontmatter into"
            )
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        write_text_if_changed(path, merge_frontmatter(text, {key: value}))
        return self

    def __setitem__(self, key: str, value: Any) -> None:
        self.set(key, value)

"""Read one shape back from a folder. The mirror of ``writer.py``.

Both walk the SAME ``placements(spec)`` table, which is what makes the round
trip symmetric by construction. Two functions that each decided for themselves
where a field lives is how the dataset layout came to write a ``FileRef`` and
read a ``FolderSpec`` — a drift no test caught because each half was
self-consistent.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.schema.data_spec.io import names
from flow_sdk.schema.data_spec.io.placement import (
    Placement,
    body_field,
    element_of,
    placements,
    unwrap,
    value_of,
)


def _document(spec: type, path: Path) -> Any:
    """A document file back into its shape: frontmatter as fields, text as body."""
    from flow_sdk.assets.frontmatter import (  # noqa: PLC0415 — pure leaf
        _extract_body,
        _extract_frontmatter,
        _yaml_load,
    )

    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    front = _extract_frontmatter(text)
    fields: dict[str, Any] = dict(_yaml_load(front)) if front else {}
    body_name = body_field(spec)
    if body_name:
        fields[body_name] = _extract_body(text) if front else text
    return spec.model_validate(fields)


def read(spec: type, root: Path) -> Any:
    """Rebuild *spec* from *root*. The inverse of ``writer.write``."""
    root = Path(root)
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415 — cycle-safe: lazy

    document = load_json_dict(root / names.main_document(spec))
    fields: dict[str, Any] = {}

    for name, place in placements(spec).items():
        annotation = unwrap(spec.model_fields[name].rebuild_annotation())

        if place in (Placement.INLINE, Placement.FREE_SECTION):
            if name in document:
                fields[name] = document[name]
        elif place is Placement.BODY:
            path = root / names.field_file(name, ".md")
            if path.is_file():
                fields[name] = path.read_text(encoding="utf-8")
        elif place is Placement.DOCUMENT:
            path = root / names.field_file(name, names.ext_for(annotation))
            if path.is_file():
                fields[name] = _document(annotation, path)
        elif place is Placement.FILE_BYTES:
            path = root / names.field_file(name, getattr(annotation, "ext", ".bin"))
            if path.is_file():
                fields[name] = annotation(path.read_bytes())
        elif place is Placement.DIR_LIST:
            element = element_of(annotation)
            folder = root / name
            if element is not None and folder.is_dir():
                # Sorted: the ordinal names were chosen so lexicographic order
                # IS insertion order, and a named element sorts stably too.
                fields[name] = [read(element, child) for child in sorted(folder.iterdir()) if child.is_dir()]
        elif place is Placement.DIR_DICT:
            valued = value_of(annotation)
            folder = root / name
            if valued is not None and folder.is_dir():
                fields[name] = {
                    child.name: read(valued, child) for child in sorted(folder.iterdir()) if child.is_dir()
                }

    return spec.model_validate(fields)


__all__ = ["read"]

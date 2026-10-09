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


def _document(spec: type, path: Path, *, checked: bool = True) -> Any:
    """A document file back into its shape: frontmatter as fields, text as body (its raw fields
    when not ``checked``)."""
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
    if not checked:
        return fields
    return _located(spec.model_validate(fields), {body_name: path} if body_name and path.is_file() else {})


def _located(value: Any, files: dict[str, Path]) -> Any:
    """Stamp each carrier field with the file it was read from (``Text.path`` / ``Binary.path``)."""
    for name, path in files.items():
        held = getattr(value, name, None)
        if held is not None:
            held.path = path
    return value


def read(spec: type, root: Path) -> Any:
    """Rebuild *spec* from *root*. The inverse of ``writer.write``."""
    fields, files = _gather(spec, Path(root), checked=True)
    return _located(spec.model_validate(fields), files)


def read_fields(spec: type, root: Path) -> dict[str, Any]:
    """What *root* holds for *spec*, as plain fields, NOT validated -- a value that no longer fits
    its shape, read so it can be shown or repaired. Bytes fields are left out."""
    return _gather(spec, Path(root), checked=False)[0]


def _gather(spec: type, root: Path, *, checked: bool) -> tuple[dict[str, Any], dict[str, Path]]:
    """The fields (and the files they came from) *root* holds for *spec*; nested values are read
    with ``read`` when ``checked``, else as plain fields too."""
    nested = read if checked else read_fields
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415 — cycle-safe: lazy

    document = load_json_dict(root / names.main_document(spec))
    fields: dict[str, Any] = {}
    files: dict[str, Path] = {}

    for name, place in placements(spec).items():
        field = spec.model_fields[name]
        annotation = unwrap(field.rebuild_annotation())

        if place in (Placement.INLINE, Placement.FREE_SECTION):
            if name in document:
                fields[name] = document[name]
        elif place is Placement.BODY:
            path = root / names.field_file(name, ".md")
            if path.is_file():
                fields[name] = path.read_text(encoding="utf-8")
                files[name] = path
            elif isinstance(document.get(name), str):
                # A document written before this field became its own file still carries it inline;
                # read it rather than lose it. The next write puts it in the file.
                fields[name] = document[name]
        elif place is Placement.DOCUMENT:
            path = root / names.field_file(name, names.ext_for(annotation))
            if path.is_file():
                fields[name] = _document(annotation, path, checked=checked)
        elif place is Placement.FILE_BYTES:
            path = root / names.field_file(name, getattr(annotation, "ext", ".bin"))
            if path.is_file() and checked:
                fields[name] = annotation(path.read_bytes())
                files[name] = path
        elif place is Placement.DIR_LIST:
            element = element_of(annotation)
            folder = root / name
            if isinstance(document.get(name), list):
                fields[name] = document[name]  # a list of references, written inline
            elif element is not None and folder.is_dir():
                # Sorted: the ordinal names were chosen so lexicographic order
                # IS insertion order, and a named element sorts stably too.
                fields[name] = [nested(element, child) for child in sorted(folder.iterdir()) if child.is_dir()]
            elif element is not None and field.is_required():
                # An EMPTY list is an empty folder, and git (a wheel, a zip) does not keep an empty
                # folder: on any clean checkout it is simply absent. Absent therefore reads as
                # empty, or every row with no elements fails "field required" off the author's disk.
                fields[name] = []
        elif place is Placement.DIR_DICT:
            valued = value_of(annotation)
            folder = root / name
            if valued is not None and folder.is_dir():
                fields[name] = {
                    child.name: nested(valued, child) for child in sorted(folder.iterdir()) if child.is_dir()
                }
            elif valued is not None and field.is_required():
                fields[name] = {}  # same: an empty map is a folder nothing keeps

    return fields, files


__all__ = ["read", "read_fields"]

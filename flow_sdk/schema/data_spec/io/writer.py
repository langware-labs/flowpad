"""Write one shape to a folder. The tree walk; ``placement.py`` is the rule.

Absorbs the write half of ``assets/serialization.py`` — ``render_entity_json``,
``write_entity_bodies``, ``entity_body_path``, ``_frontmatter``, ``_manifest``,
``_write_main``. What it does NOT absorb is where the folder is or which
identity carrier it uses: that is a ``TypeInfo`` question, and ``TypeInfo``
lives above this layer. The adapter answers it and calls in here.

The invariant every branch serves: **``load(save(x)) == x``.** A placement that
cannot be read back is a bug in this file, not a documented quirk — which is
what the old dataset layout had, where a ``FileRef`` written under a slot came
back as a ``FolderSpec``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.io import names
from flow_sdk.schema.data_spec.io.identity import Carrier, ensure_id
from flow_sdk.schema.data_spec.io.placement import Placement, body_field, placements, unwrap


def _json(path: Path, payload: dict) -> None:
    # No mkdir: every caller has already made the directory it writes into.
    # UTF-8 as written: a "–" stays one, so a file under git diffs on what changed, not on escapes.
    path.write_text(json.dumps(payload, indent=2, default=str, ensure_ascii=False) + "\n", encoding="utf-8")


#: Placements that ride inside their parent's json rather than a file of their own.
_IN_DOCUMENT = (Placement.INLINE, Placement.FREE_SECTION)


def _inline_fields(value: Any) -> dict:
    """The fields that belong in this value's own document, as JSON.

    ONE encoder, used by the root's json and by a nested document's
    frontmatter. Two spellings here is how a field comes to be written one way
    at the top level and another way one level down — the drift ``reader.py``
    exists to make impossible.
    """
    # ``include``, not filter-after: a field kept in its OWN file may hold bytes
    # that have no json form at all, and dumping the whole model to throw most
    # of it away would raise on them before the filter ever ran.
    spec = type(value)
    wanted = {name for name, place in placements(spec).items() if place in _IN_DOCUMENT}
    if not wanted:
        return {}
    # A field that is None where None is its default is left out: it reads back as the same None,
    # and a document under git keeps only what a value says, not a ``null`` per unset optional.
    return {name: held for name, held in value.model_dump(mode="json", include=wanted).items()
            if held is not None or not _defaults_to_none(spec, name)}


def _defaults_to_none(spec: type, name: str) -> bool:
    info = spec.model_fields[name]
    return info.default is None and info.default_factory is None


def _document_text(value: Any) -> str:
    """A document as its file's text: frontmatter, then the body.

    ``assets/frontmatter`` is pure stdlib and imports nothing from ``flow_sdk``,
    so using it here adds no dependency — only the render is borrowed, never
    the asset machinery around it.
    """
    from flow_sdk.assets.frontmatter import _render_frontmatter  # noqa: PLC0415 — pure leaf

    body_name = body_field(type(value))
    header = {k: v for k, v in _inline_fields(value).items() if v not in (None, "", [], {})}
    body = str(getattr(value, body_name, "") or "") if body_name else ""
    front = _render_frontmatter(header) if header else ""
    if not front:
        return body
    # The closing ``---`` must end its own line, or the reader's extractor sees
    # no frontmatter at all and the whole file becomes the body.
    return f"{front.rstrip()}\n{body}"


def _drop_stale_elements(folder: Path, keep: "dict[str, Any]") -> None:
    """Remove the element folders a previous save wrote that this one will not: the reader loads
    every element folder it finds, so a list saved shorter would come back at its old length."""
    import shutil  # noqa: PLC0415

    for child in folder.iterdir():
        if child.is_dir() and child.name not in keep:
            shutil.rmtree(child)


def write(value: Any, root: Path, *, carrier: Optional[Carrier] = None, _nested: bool = False) -> str:
    """Write *value* into *root*, and return the folder's id.

    Mints the id once (§6) — a second write keeps it, so re-saving a folder
    never forks the entity it stands for.

    Only the ROOT gets an id. A list element is part of its parent's value, not
    an entity of its own; minting per element would put an identity capsule
    beside every row and make a copied folder claim to be the same thing.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    spec = type(value)
    # A free section is an untyped payload, and here it rides in the main
    # document like any other value. The two-section envelope is a TypeInfo
    # choice the asset adapter applies above this layer.
    document: dict[str, Any] = _inline_fields(value)

    for name, place in placements(spec).items():
        held = getattr(value, name, None)

        if place in _IN_DOCUMENT:
            continue  # already in ``document``
        if place is Placement.BODY:
            # At the ROOT a body field is its own file beside the main document
            # (``setup`` -> ``setup.md``). Nested as a DOCUMENT it is instead
            # that document's text, under its frontmatter — which is why
            # ``_document_text`` reads it rather than this branch.
            text = str(held or "")
            path = root / names.field_file(name, ".md")
            if text:
                path.write_text(text, encoding="utf-8")
                held.path = path  # ``Text.path``: where it now lives
            else:
                # An emptied body leaves no file behind: the reader loads whatever file is
                # there, so a stale ``setup.md`` would come back as the value just cleared.
                path.unlink(missing_ok=True)
        elif held is None:
            # Same rule for a document or bytes field set back to None.
            annotation = unwrap(spec.model_fields[name].rebuild_annotation())
            if place is Placement.DOCUMENT:
                (root / names.field_file(name, names.ext_for(annotation))).unlink(missing_ok=True)
            elif place is Placement.FILE_BYTES:
                (root / names.field_file(name, getattr(annotation, "ext", ".bin"))).unlink(missing_ok=True)
            elif place in (Placement.DIR_LIST, Placement.DIR_DICT) and (root / name).is_dir():
                _drop_stale_elements(root / name, {})
            continue
        elif place is Placement.DOCUMENT:
            path = root / names.field_file(name, names.ext_for(type(held)))
            path.write_text(_document_text(held), encoding="utf-8")
        elif place is Placement.FILE_BYTES:
            ext = getattr(type(held), "ext", ".bin")
            path = root / names.field_file(name, ext)
            path.write_bytes(bytes(held))
            held.path = path  # ``Binary.path``
        elif place is Placement.DIR_LIST:
            folder = root / name
            folder.mkdir(parents=True, exist_ok=True)
            elements = {names.list_element(element, index): element for index, element in enumerate(held or [], start=1)}
            _drop_stale_elements(folder, elements)
            for element_name, element in elements.items():
                write(element, folder / element_name, _nested=True)
        elif place is Placement.DIR_DICT:
            folder = root / name
            folder.mkdir(parents=True, exist_ok=True)
            elements = {names.dict_element(key): element for key, element in (held or {}).items()}
            _drop_stale_elements(folder, elements)
            for element_name, element in elements.items():
                write(element, folder / element_name, _nested=True)

    _json(root / names.main_document(spec), document)
    return "" if _nested else ensure_id(root, carrier)



__all__ = ["write"]

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
from flow_sdk.schema.data_spec.io.placement import Placement, body_field, placements


def _json(path: Path, payload: dict) -> None:
    # No mkdir: every caller has already made the directory it writes into.
    path.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")


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
    wanted = {name for name, place in placements(type(value)).items() if place in _IN_DOCUMENT}
    return value.model_dump(mode="json", include=wanted) if wanted else {}


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
            if text:
                (root / names.field_file(name, ".md")).write_text(text, encoding="utf-8")
        elif held is None:
            continue
        elif place is Placement.DOCUMENT:
            path = root / names.field_file(name, names.ext_for(type(held)))
            path.write_text(_document_text(held), encoding="utf-8")
        elif place is Placement.FILE_BYTES:
            ext = getattr(type(held), "ext", ".bin")
            (root / names.field_file(name, ext)).write_bytes(bytes(held))
        elif place is Placement.DIR_LIST:
            folder = root / name
            folder.mkdir(parents=True, exist_ok=True)
            for index, element in enumerate(held or [], start=1):
                write(element, folder / names.list_element(element, index), _nested=True)
        elif place is Placement.DIR_DICT:
            folder = root / name
            folder.mkdir(parents=True, exist_ok=True)
            for key, element in (held or {}).items():
                write(element, folder / names.dict_element(key), _nested=True)

    _json(root / names.main_document(spec), document)
    return "" if _nested else ensure_id(root, carrier)



__all__ = ["write"]

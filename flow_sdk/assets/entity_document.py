"""An ENTITY DOCUMENT as an editable ``AssetDocument``: ``<type>.json`` holds the fields, ``<field>.md`` the body.

The editor, the places writer and auto-versioning all speak ``AssetDocument`` + ``DocumentPatch``
(``flow_sdk.assets.document``). A markdown document carries both halves in one file; an entity document
carries them in two, so the revision covers both and a patch writes whichever changed. Identity (``type``,
``id``) is never patched, and every field change is validated by the type's ``asset_spec``.

What the document LOOKS like is not decided here: the text comes from ``render_entity_json`` and the body
from ``write_entity_bodies`` (``flow_sdk.assets.serialization``), so a patch and an entity save leave the
same bytes. This module owns only what is its own — the lock, the revision, and the version bump.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from flow_sdk.assets.document import AssetDocument, DocumentConflict, DocumentPatch, content_revision

#: Keys a patch may never touch: the document's identity.
IDENTITY_KEYS = frozenset({"type", "id", "asset_id"})


def entity_info_for(path: str | Path) -> Any:
    """The registered entity-document type whose main file ``path`` is, or ``None``."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    target = Path(path)
    if target.suffix.lower() != ".json":
        return None
    try:
        info = SchemaRegistry.get(SchemaRegistry.type_for(target) or "")
    except Exception:  # noqa: BLE001 — a registry that cannot classify means "not an entity document"
        return None
    if info is None or not info.is_entity_document or target.name != info.shape.main:
        return None
    return info


def _body_path(info: Any, main: Path) -> Optional[Path]:
    from flow_sdk.assets.serialization import entity_body_path  # noqa: PLC0415

    return None if info.body_file is None else entity_body_path(main.parent, info.body_file)


def _read(main: Path, info: Any) -> tuple[bytes, bytes]:
    """The two files as they are on disk: raw main bytes, raw body bytes (``b""`` when there is none)."""
    body_path = _body_path(info, main)
    return main.read_bytes(), body_path.read_bytes() if body_path is not None and body_path.is_file() else b""


def _parse(raw: bytes, info: Any) -> dict:
    """The main file's object — malformed or non-object reads as ``{}``, the same tolerance as ``load_json_dict``."""
    import json  # noqa: PLC0415

    try:
        loaded = json.loads(raw)
    except ValueError:
        loaded = None
    doc = loaded if isinstance(loaded, dict) else {}
    declared = doc.get("type")
    if declared not in (None, "", info.type_name):
        raise ValueError(f"{info.shape.main} is a {declared!r} document, not a {info.type_name!r}")
    return doc


def _as_document(raw: bytes, doc: dict, body: bytes) -> AssetDocument:
    fields = {key: value for key, value in doc.items() if key not in IDENTITY_KEYS}
    return AssetDocument(raw_text=raw.decode("utf-8"), body=body.decode("utf-8"), fields=fields, revision=content_revision(raw + b"\0" + body))


def read_entity_document_bytes(raw: bytes, body: bytes, info: Any) -> AssetDocument:
    """The document the two files hold: ``raw`` is ``<type>.json``, ``body`` its body file (``b""`` when absent)."""
    return _as_document(raw, _parse(raw, info), body)


def patch_entity_document_bytes(
    raw: bytes, body: bytes, patch: DocumentPatch, *, expected_revision: str | None = None, version_base: str | None = None, info: Any,
) -> tuple[AssetDocument, bytes, bytes]:
    """Apply ``patch`` to the two halves; returns the document and the bytes each file now holds.

    Pure — no filesystem — so a store that is not a disk (the hub's storage) patches the same way the desktop does.
    ``version_base`` is the committed ``<type>.json`` text (HEAD): when the fields or the body now differ
    from it (ignoring ``version``), the document's ``version`` is bumped, as a markdown asset's is."""
    from flow_sdk.assets.identity_carrier import dump_json_document  # noqa: PLC0415
    from flow_sdk.assets.versioning import bumped_version, strip_version, strip_version_fields  # noqa: PLC0415

    if IDENTITY_KEYS.intersection((*patch.set_fields, *patch.drop_fields)):
        raise ValueError("Document updates cannot change asset identity")
    doc = _parse(raw, info)
    before = _as_document(raw, doc, body)
    if expected_revision is not None and expected_revision != before.revision:
        raise DocumentConflict(Path(info.shape.main), before.revision)
    fields = {key: value for key, value in before.fields.items() if key not in patch.drop_fields}
    fields.update(patch.set_fields)
    # The same normalisation the writer applies, so "changed" means changed, not reformatted.
    new_body = before.body if patch.body is None or info.body_file is None else patch.body.strip()
    body_changed = new_body != before.body
    if fields == before.fields and not body_changed:
        return before, raw, body
    # The file's keys are the spec's ALIASES where it declares one (``data_driver_name``), its names otherwise.
    spec_keys = {f.alias or name for name, f in info.asset_spec.model_fields.items()}
    info.asset_spec.model_validate({key: value for key, value in fields.items() if key in spec_keys})
    identity = {key: doc[key] for key in ("type", "id") if key in doc}
    document = {"type": info.type_name, **identity, **fields}
    # Decide the version against the dicts, then render once — the text is the OUTPUT, not a comparison key.
    if version_base is not None and (body_changed or strip_version(version_base) != strip_version_fields(document)):
        fields["version"] = document["version"] = bumped_version(fields.get("version", 1))
    after = dump_json_document(document).encode("utf-8")
    body_bytes = (f"{new_body}\n".encode() if new_body else b"") if body_changed else body
    return _as_document(after, document, body_bytes), after, body_bytes


def read_entity_document(path: str | Path, info: Any = None) -> AssetDocument:
    main = Path(path)
    info = info or entity_info_for(main)
    if info is None:
        raise ValueError(f"{main} is not an entity document")
    return read_entity_document_bytes(*_read(main, info), info)


def patch_entity_document(
    path: str | Path, patch: DocumentPatch, *, expected_revision: str | None = None, version_base: str | None = None, info: Any = None,
) -> AssetDocument:
    """Apply ``patch`` under the document's writer lock; the returned document is what is now on disk."""
    from flow_sdk.capsules.atomic import atomic_write, capsule_lock  # noqa: PLC0415

    main = Path(path).resolve()
    info = info or entity_info_for(main)
    if info is None:
        raise ValueError(f"{main} is not an entity document")
    with capsule_lock(main):
        raw, body = _read(main, info)
        try:
            document, after, body_bytes = patch_entity_document_bytes(
                raw, body, patch, expected_revision=expected_revision, version_base=version_base, info=info
            )
        except DocumentConflict as exc:  # the bytes layer knows the file's name; this layer knows where it is
            raise DocumentConflict(main, exc.current_revision) from None
        # The bytes this call read are still the bytes on disk: nobody wrote between the lock and here.
        on_disk = main.read_bytes()
        if on_disk != raw:
            raise DocumentConflict(main, content_revision(on_disk + b"\0" + body))
        if after != raw:
            atomic_write(main, after)
        if body_bytes != body:
            atomic_write(_body_path(info, main), body_bytes)
        # What was just written IS the document; re-reading it would only prove the filesystem works.
        return document


__all__ = [
    "IDENTITY_KEYS",
    "entity_info_for",
    "patch_entity_document",
    "patch_entity_document_bytes",
    "read_entity_document",
    "read_entity_document_bytes",
]

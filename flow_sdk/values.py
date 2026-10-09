"""Values with identity: one value of a schema, stored once, referenced as ``<kind>.id.<uuid>``.

A value that many things share (the navigation map an eval run offered) is stored ONCE in the
asset that keeps it -- ``<asset>/agentic-assets/value/<name>/value.json`` (its fields plus
``spec_kind``) and the folder's standard identity capsule -- and everything else holds a reference
to it (``value_ref``). A new version exists only when the content changes: ``save_value`` looks
for the same content first.

    ref = save_value(navigation_map(), store_of(dataset))   # the same ref again next time
    value = resolve_ref(ref, near=store_of(dataset))        # the stored value, as its schema
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR
from flow_sdk.schema.data_spec.io.identity import FolderCapsule, ensure_id
from flow_sdk.schema.data_spec.spec import DataSpec, spec_tag
from flow_sdk.schema.data_spec.value_ref import parse_ref, ref_of

#: The one main file of a value folder (its kind is inside, as ``spec_kind``).
VALUE_FILE = "value.json"


def store_of(asset_folder: Path | str) -> Path:
    """Where an asset keeps the values it owns."""
    return Path(asset_folder) / AGENTIC_ASSETS_DIR / "value"


def content_hash(fields: Any) -> str:
    """A value's content digest: its fields, canonical JSON, its ``spec_kind`` tag left out."""
    from flow_sdk.llm_index.core import sha256_bytes  # noqa: PLC0415
    from flow_sdk.semantic_lock.targets import canonical_entity_bytes  # noqa: PLC0415

    if isinstance(fields, DataSpec):
        fields = fields.model_dump(mode="json")
    return sha256_bytes(canonical_entity_bytes({k: v for k, v in fields.items() if k != "spec_kind"}))


def _documents(store: Path):
    """``(folder, document)`` for every value folder in a store."""
    if not store.is_dir():
        return
    for folder in sorted(p for p in store.iterdir() if (p / VALUE_FILE).is_file()):
        try:
            yield folder, json.loads((folder / VALUE_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue


def save_value(value: DataSpec, store: Path | str) -> str:
    """Store ``value`` in ``store`` once and answer its reference. The same content already there
    is reused -- a new version only when something changed."""
    kind = spec_tag(value)
    if not kind:
        raise ValueError(f"{type(value).__name__} has no kind: only a value of a registered schema can be referenced")
    store = Path(store)
    digest = content_hash(value)
    for folder, doc in _documents(store):
        if doc.get("spec_kind") == kind and content_hash(doc) == digest and (found := FolderCapsule().read(folder)):
            return ref_of(kind, found)
    folder = store / f"{kind}-{digest[:10]}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / VALUE_FILE).write_text(
        json.dumps({"spec_kind": kind, **value.model_dump(mode="json")}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return ref_of(kind, ensure_id(folder))


def resolve_ref(ref: str, near: Path | str) -> DataSpec:
    """The value ``ref`` names, from the store at ``near``, as its schema. ``ValueError`` for
    something that is not a reference, ``LookupError`` when the store does not hold it."""
    from flow_sdk.schema.data_spec._kinds import resolve_kind  # noqa: PLC0415
    from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

    parsed = parse_ref(ref)
    if parsed is None:
        raise ValueError(f"{ref!r} is not a reference ('<kind>.id.<uuid>')")
    wanted, wanted_id = parsed
    for folder, doc in _documents(Path(near)):
        if FolderCapsule().read(folder) != wanted_id:
            continue
        kind = str(doc.pop("spec_kind", ""))
        schema = resolve_kind(kind)
        if not kind_matches(wanted, kind) or not (isinstance(schema, type) and issubclass(schema, DataSpec)):
            raise LookupError(f"{ref!r} names a {wanted} value, but {folder} holds a {kind or 'kindless'} one")
        return schema.model_validate(doc)
    raise LookupError(f"no value {ref}")


__all__ = ["VALUE_FILE", "content_hash", "resolve_ref", "save_value", "store_of"]

"""Pure filesystem asset document decoding and rendering."""
from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any, Optional

from pydantic import TypeAdapter

from flow_sdk.assets.layout import Folder
from flow_sdk.fs_store.serializer.fields import FieldKind, asset_class, asset_info, field_kinds, spec_layout


def _main_doc(info: Any, root: Path) -> Optional[Path]:
    """The main document's path for a stored asset, or None."""
    if info is None:
        return root if root.suffix else None
    return info.layout_of(root).body


def _asset_ref(info: Any, root: Path) -> Path:
    """The ref the type's identity backend is registered for — the asset ROOT."""
    return info.layout_of(root).root or root


def _sub_target(root: Path, name: str, sub_cls: type) -> Path:
    """Where a single nested asset field lives — by the nested TYPE's own
    placement: a folder-layout type is a directory, a file-layout one a file."""
    info = asset_info(sub_cls)
    return root / name if isinstance(info.shape, Folder) else root / f"{name}{info.shape.ext}"


def _list_element_ext(sub_cls: type) -> str:
    """A ``list[...]`` of assets is a directory of FILES, one per element —
    ``check_asset_spec`` refused a folder-layout element type at registration."""
    return asset_info(sub_cls).shape.ext


def _manifest_layout(info: Any) -> str:
    """``sections`` = ``{metadata, data}``; ``flat`` = the header's keys merged
    onto the payload's own document. Declared on ``TypeInfo``; else sections
    when the spec has a ``FreeSection``, flat otherwise."""
    declared = getattr(info, "manifest_layout", None)
    if declared:
        return declared
    return "sections" if spec_layout(info.asset_spec).free else "flat"


def _manifest(obj: Any, info: Any) -> dict[str, Any]:
    """The JSON main doc. ``sections``: the header under ``metadata``, the
    spec's ``FreeSection`` as the free ``data`` section. ``flat``: the header's
    keys merged ONTO the payload's own document (a dict-valued header key — a
    ``summary`` — merges one level deep so payload-only keys inside it survive)."""
    free_field = spec_layout(info.asset_spec).free
    free = getattr(obj, free_field, None) if free_field else None
    payload = free if isinstance(free, dict) else {}
    header = _frontmatter(obj, info)
    if _manifest_layout(info) == "sections":
        return {"metadata": header, "data": payload}
    doc = dict(payload)
    for key, value in header.items():
        if isinstance(value, dict) and isinstance(doc.get(key), dict):
            doc[key] = {**doc[key], **value}
        else:
            doc[key] = value
    return doc


def _body(obj: Any, info: Any) -> str:
    """The spec's ``Body`` field, stripped; ``""`` when the spec has none."""
    body_field = spec_layout(info.asset_spec).body
    return (getattr(obj, body_field, "") or "").strip() if body_field else ""


@cache
def _field_adapter(cls: type, name: str) -> TypeAdapter:
    return TypeAdapter(cls.model_fields[name].rebuild_annotation())


def _field_value(obj: Any, name: str) -> Any:
    value = getattr(obj, name)
    # Hydrated rows can already hold their serialized scalar (e.g. an enum's
    # string value). Only structured/custom values need annotation serialization.
    return value if value is None or isinstance(value, (str, int, float, bool)) else _field_adapter(type(obj), name).dump_python(value)


def _frontmatter(obj: Any, info: Any) -> dict[str, Any]:
    """The spec SELECTS which fields are frontmatter — its ``Body`` and
    ``FreeSection`` are the document, not the header, and ``extra="ignore"``
    drops the rest. ``None`` is absent, not ``null``: absent reads back as the
    field's default, which is how "None means inherit" round-trips. A
    path-named asset writes its name first, as authored."""
    spec = info.asset_spec
    lay = spec_layout(spec)
    # By alias: a spec field may carry the FILE's key (``schema`` on a manifest)
    # while the entity holds it under the row's name (``manifest_schema``).
    # ``exclude_defaults``: a default is not authored — absent reads back as the
    # default, so the file says only what the author said (a fresh doc has an
    # empty header; a counter is written only once it moved).
    # ``sectioned``: a ``SectionedHeader`` nests its section fields for the FILE only.
    from flow_sdk.fs_store.serializer.fields import DISK_ONLY, field_kinds
    structural = {name for name, kind in field_kinds(spec) if kind in DISK_ONLY}
    validated = obj if isinstance(obj, spec) else spec.model_validate({
        name: _field_value(obj, name) for name in lay.header_fields if name in type(obj).model_fields
    })
    out = validated.model_dump(
        mode="json", exclude_none=True, exclude_defaults=True, by_alias=True,
        exclude=lay.marker_fields | structural, context={"sectioned": True},
    )
    if info.name_from_path and getattr(obj, "name", None):
        out = {"name": obj.name, **out}
    from flow_sdk.assets.identity_carrier import Frontmatter  # noqa: PLC0415

    if isinstance(info.identity_carrier, Frontmatter) and getattr(obj, "id", None):
        # The header IS this type's identity carrier: an owned re-render must
        # keep the id (it rewrites the header wholesale), so it is written first.
        out = {"id": str(obj.id), **out}
    return out


def _read_identity(info: Any, root: Path) -> str:
    """The id the type's carrier holds at ``root``, or ``""``. A malformed carrier raises."""
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415

    if info is None or info.identity_carrier is None:
        return ""
    return info.read_id(FSRef(_asset_ref(info, root))) or ""


def render_asset(obj: Any, info: Any) -> Optional[str]:
    """The main document's TEXT, or None when the type has none. A type
    with no ``asset_spec`` renders through ``TypeInfo.default_body_fn`` (a
    template the spec vocabulary cannot express) — or nothing."""
    if info is not None and info.render_fn is not None:
        return info.render_fn(obj, info)
    if info is None or info.asset_spec is None:
        fn = info.default_body_fn if info else None
        return fn(obj) if fn is not None else None
    from flow_sdk.assets.frontmatter import _render_frontmatter

    folder = isinstance(info.shape, Folder)
    main = info.shape.main if folder else None
    if main and main.endswith(".json"):
        # A flat document IS its payload: an entity carrying no payload (a
        # metadata-only save of a report) has nothing to say — no document,
        # so an owned file is never clobbered by a summary-only render.
        free_field = spec_layout(info.asset_spec).free
        if _manifest_layout(info) == "flat" and free_field and getattr(obj, free_field, None) is None:
            return None
        return json.dumps(_manifest(obj, info), indent=2, ensure_ascii=False) + "\n"
    if folder and not main:
        return None
    body = _body(obj, info)
    tail = f"\n\n{body}\n" if body or not folder else "\n"
    return _render_frontmatter(_frontmatter(obj, info)) + tail


def read_main(info: Any, root: Path, *, field_data: dict | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(entity kwargs, raw header)`` — the raw header is what the rows
    layout reads its knobs from."""
    from flow_sdk.fs_store.fs_ref import FrontMatterFsRef  # noqa: PLC0415
    from flow_sdk.schema.data_spec.layout import load_doc, load_json_dict  # noqa: PLC0415

    spec = info.asset_spec
    lay = spec_layout(spec)
    main = _main_doc(info, root)
    header_raw: dict[str, Any] = {}
    data: dict[str, Any] = {}
    if main is not None and main.suffix == ".json":
        if _manifest_layout(info) == "sections":
            header_raw, free = load_doc(main)
            if free:
                data[lay.free] = free
        else:
            # Flat: the whole document is both the header's source and,
            # for a spec with a ``FreeSection``, the payload itself.
            header_raw = load_json_dict(main)
            if lay.free and header_raw:
                data[lay.free] = header_raw
    elif main is not None:
        ref = FrontMatterFsRef(main)
        header_raw = ref.read_frontmatter()
        if lay.body:
            data[lay.body] = ref.read_body().strip()
    # Absent on disk ⇒ the entity's DEFAULT, not None: the spec's None is
    # "not present", and a non-Optional entity field (an enum) must not see it.
    # The marker fields are EXCLUDED: they were read above, and the spec's
    # own default ("") must not overwrite the body/section just read.
    data.update(spec.model_validate({**header_raw, **(field_data or {})}).model_dump(exclude_none=True, exclude=lay.marker_fields))
    if info.name_from_path:
        data["name"] = header_raw.get("name") or (root.name if root.is_dir() else root.stem)
    return data, header_raw


def read_asset_data(path: Path, info: Any, *, identity: str | None = None):
    """Decode file-owned fields into a filesystem record without an Entity."""
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.fs_ref import FSRef

    layout = info.layout_of(path, verify=True)
    resolved_id = identity or info.read_identity(layout)
    if info.asset_spec is None:
        if info.from_disk_fn is None:
            raise ValueError(f"{info.type_name} has no filesystem reader")
        records = info.from_disk_fn(FSRef(layout.root, read_only=True), resolved_id)
        if len(records) != 1:
            raise ValueError("Asset reader must return one record")
        return records[0]
    data, header = read_main(info, layout.root, field_data=read_asset_fields(layout.root, info))
    if info.rows_field and info.rows_layout_field:
        from flow_sdk.schema.data_spec.dataset_spec import DEFAULT_DATASET_SPEC, DataLayoutEnum
        from flow_sdk.schema.data_spec.layout import coerce_dataset_enum, layout_for
        rows_layout = coerce_dataset_enum(header.get(info.rows_layout_field), DataLayoutEnum, DataLayoutEnum.CSV)
        data[info.rows_field] = layout_for(rows_layout).read(
            layout.root, DEFAULT_DATASET_SPEC.example_type(), dataset_id=resolved_id,
            field_spec=header.get("field_spec") or {}, delimiter=header.get("delimiter") or ",",
        )
    if info.derive_fields_fn is not None:
        info.derive_fields_fn(data, layout.root, header)
    return FSRecord(type=info.type_name, id=resolved_id, asset_ref=str(layout.root), **data)


def read_asset_parent(path: Path, info: Any):
    """An explicitly authored parent reference; never inferred from containment."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id
    from flow_sdk.assets.document import read_document
    from flow_sdk.fs_store.type_id import TypeId

    layout = info.layout_of(path, verify=True)
    candidates = [layout.body] if layout.body is not None else []
    if isinstance(info.shape, Folder):
        candidates.append(layout.root / "metadata.json")
    for candidate in candidates:
        if not candidate.is_file():
            continue
        if candidate.suffix == ".json":
            fields = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(fields, dict) and isinstance(fields.get("metadata"), dict):
                fields = {**fields, **fields["metadata"]}
        else:
            document = read_document(candidate)
            if document.metadata_error:
                raise ValueError(document.metadata_error)
            fields = document.fields
        value = fields.get("parent_type_id") if isinstance(fields, dict) else None
        if value:
            ref = TypeId(value)
            if not is_valid_entity_id(ref.id):
                raise ValueError("Authored asset parent must have a valid entity ID")
            return ref
    return None


def read_asset_fields(root: Path, info: Any) -> dict[str, Any]:
    """Nested DataSpec asset fields use the same registered disk grammar."""
    from flow_sdk.fs_store.serializer.fields import FieldKind, asset_class, field_kinds

    fields = {}
    for name, kind in field_kinds(info.asset_spec):
        if kind not in (FieldKind.SUB_ASSET, FieldKind.SUB_ASSET_LIST):
            continue
        spec, _ = asset_class(info.asset_spec.model_fields[name].rebuild_annotation())
        child_info = asset_info(spec)
        if kind is FieldKind.SUB_ASSET_LIST:
            folder = root / name
            paths = sorted(folder.glob(f"*{child_info.shape.ext}")) if folder.is_dir() else []
        else:
            target = _sub_target(root, name, spec)
            paths = [target] if target.exists() else []
        values = []
        for path in paths:
            record = read_asset_data(path, child_info)
            payload = {key: value for key, value in record.meta_dict().items() if key in spec.model_fields}
            values.append(spec.model_validate(payload))
        if kind is FieldKind.SUB_ASSET_LIST:
            fields[name] = values
        elif values:
            fields[name] = values[0]
    return fields


def write_asset_fields(root: Path, info: Any, spec: Any) -> None:
    """Materialize declared nested specs; scope selection stays with the caller."""
    from flow_sdk.assets.creation import create_asset
    from flow_sdk.fs_store.serializer.fields import FieldKind, asset_class, field_kinds
    from flow_sdk.schema.types import EntityType

    if info.asset_spec is None:
        return
    for name, kind in field_kinds(info.asset_spec):
        if kind not in (FieldKind.SUB_ASSET, FieldKind.SUB_ASSET_LIST):
            continue
        child_spec, _ = asset_class(info.asset_spec.model_fields[name].rebuild_annotation())
        child_info = asset_info(child_spec)
        value = getattr(spec, name, None)
        children = value or [] if kind is FieldKind.SUB_ASSET_LIST else ([] if value is None else [value])
        for child in children:
            if kind is FieldKind.SUB_ASSET_LIST:
                leaf = getattr(child, "name", None)
                if not leaf or Path(leaf).name != leaf or leaf in {".", ".."}:
                    raise ValueError("Nested asset name must be one filename component")
                destination = root / name / f"{leaf}{child_info.shape.ext}"
            else:
                destination = _sub_target(root, name, child_spec)
            create_asset(destination, EntityType(child_info.type_name), child)


def _commit_identity(info: Any, root: Path, obj: Any) -> str:
    """The identity step every disk store ends with: the carrier is
    authoritative, so the COMMITTED id may differ from the one proposed (the
    seam owns the read-only / suppression gates).

    The ref handed to ``stamp_id`` is the ASSET_REF the type's carrier
    was registered for — the folder for a folder type, the file for a file
    type; the carrier locates the main document itself."""
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415

    entity_id = getattr(obj, "id", None)
    if info is None or info.identity_carrier is None or not entity_id:
        return str(entity_id or "")
    return str(info.stamp_id(FSRef(_asset_ref(info, root)), str(entity_id)))


def _write_main(obj: Any, info: Any, root: Path, main: Optional[Path]) -> None:
    from flow_sdk.assets.document import read_document_bytes, write_document
    from flow_sdk.assets.frontmatter import _atomic_write_text

    if info is not None and isinstance(info.shape, Folder):
        root.mkdir(parents=True, exist_ok=True)       # the carrier target for a FolderCapsule
    if main is None:
        return
    # Both substrates are atomic and skip a byte-identical rewrite, so a
    # no-op save never churns the mtime the hash sentinel keys on.
    if info is None or info.asset_spec is None:
        text = render_asset(obj, info)
        if text is None:
            return                                    # nothing to render: the folder is the asset
        if main.suffix.lower() in {".md", ".markdown"}:
            document = read_document_bytes(text.encode("utf-8"))
            if document.metadata_error:
                raise ValueError(document.metadata_error)
            write_document(main, body=document.body, fields=document.fields, replace_fields=True)
        else:
            _atomic_write_text(main, text)
    elif main.suffix == ".json":
        text = render_asset(obj, info)
        if text is not None:
            _atomic_write_text(main, text)
    else:
        write_document(main, body=f"\n{_body(obj, info)}\n", fields=_frontmatter(obj, info), replace_fields=True)


def _write_fields(obj: Any, info: Any, root: Path) -> None:
    """Every field by its declared persistence. A sub-asset is stored through
    THIS serializer with its own origin, so it commits its own identity via
    its own TypeInfo. Rows go through the layout the manifest names."""
    fields = type(obj).model_fields
    for name, kind in field_kinds(type(obj)):
        value = getattr(obj, name, None)
        if kind is FieldKind.SUB_ASSET_LIST:
            sub_cls, _ = asset_class(fields[name].rebuild_annotation())
            ext = _list_element_ext(sub_cls)
            (root / name).mkdir(parents=True, exist_ok=True)
            for item in value or []:
                if not getattr(item, "name", None):
                    raise ValueError(f"{type(item).__name__}.name is required to place it in a directory")
                write_asset_tree(item, asset_info(sub_cls), root / name / f"{item.name}{ext}")
        elif kind is FieldKind.SUB_ASSET and value is not None:
            sub_cls, _ = asset_class(fields[name].rebuild_annotation())
            write_asset_tree(value, asset_info(sub_cls), _sub_target(root, name, sub_cls))
        elif kind is FieldKind.ROWS and info is not None and info.rows_layout_field:
            from flow_sdk.schema.data_spec.layout import layout_for  # noqa: PLC0415

            source = getattr(obj, "asset_ref", None)
            layout_for(getattr(obj, info.rows_layout_field)).write(
                root, value or [], dataset_id=str(getattr(obj, "id", "") or ""),
                field_spec=getattr(obj, "field_spec", None) or {}, delimiter=getattr(obj, "delimiter", None) or ",",
                source=Path(source) if source else None,
            )


def write_asset_tree(obj: Any, info: Any, root: Path, *, force: bool = False) -> str:
    """Store declared filesystem fields and identity, without constructing rows."""
    main = _main_doc(info, root)
    exists = main is not None and main.is_file()
    if force or bool(info and info.owns_main_ref) or not exists:
        _write_main(obj, info, root, main)
    if info is not None and info.asset_spec is not None:
        _write_fields(obj, info, root)
    return _commit_identity(info, root, obj)

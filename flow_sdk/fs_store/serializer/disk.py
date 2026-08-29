"""``DiskSerializer`` — the ``"local"`` origin kind. HOW an asset becomes files.

Reads and writes an asset TREE driven by its ``TypeInfo``: the layout slots
(``main_layout``, ``main_file``, …) and ``asset_spec`` — the ``DataSpec`` whose
field TYPES say what the document holds (frontmatter scalars, a ``Body``, a
``FreeSection``, bytes, rows, sub-assets). Every byte goes
through the substrate that already exists — ``FrontMatterFsRef`` (atomic,
capsule-preserving), ``load_doc``/``write_doc`` for JSON manifests, a
``DatasetLayout`` for rows — and identity goes through the type's
``IdentityBackend`` via ``TypeInfo.mint_entity_id``. Nothing here names a
concrete asset class; dispatch is by ``FieldKind``.

A type that declares no ``asset_spec`` still goes through here: it renders via
``TypeInfo.default_body_fn`` (a ``.js`` template, a ``.csv``) and loads via
``from_disk_fn`` → record → entity. Same store policy, same identity step.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, ClassVar, Optional

from flow_sdk.builtin.drivers.local_driver import _resolve_local_path
from flow_sdk.fs_store.origin.fs_origin import FSOrigin
from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer.fields import (
    FieldKind,
    asset_class,
    asset_info,
    field_kinds,
    spec_layout,
    type_default,
)

# ── shared helpers ────────────────────────────────────────────────────────────

def _type_of(obj: Any) -> str:
    """The registered type name — from the entity, else its ``type`` field default."""
    get = getattr(obj, "get_type", None)
    return get() if callable(get) else type_default(type(obj))


def _main_doc(info: Any, root: Path) -> Optional[Path]:
    """The main document's path for a stored asset, or None."""
    if info is None:
        return root if root.suffix else None
    if info.main_layout == "folder":
        return root / info.main_file if info.main_file else None
    return root


def _asset_ref(info: Any, root: Path) -> Path:
    """The ref the type's identity backend is registered for: the inner main
    file of a ``main_file_is_asset_ref`` folder type, else the root itself.
    Inverse of ``TypeInfo.storage_root_for``."""
    return info.asset_ref_for(root) if info.main_layout == "folder" else root


def _sub_target(root: Path, name: str, sub_cls: type) -> Path:
    """Where a single nested asset field lives — by the nested TYPE's own
    placement: a folder-layout type is a directory, a file-layout one a file."""
    info = asset_info(sub_cls)
    return root / name if info.main_layout == "folder" else root / f"{name}{info.main_ext}"


def _list_element_ext(sub_cls: type) -> str:
    """A ``list[...]`` of assets is a directory of FILES, one per element —
    ``check_asset_spec`` refused a folder-layout element type at registration."""
    return asset_info(sub_cls).main_ext


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


def _frontmatter(obj: Any, info: Any) -> dict[str, Any]:
    """The spec SELECTS which fields are frontmatter — its ``Body`` and
    ``FreeSection`` are the document, not the header, and ``extra="ignore"``
    drops the rest. ``None`` is absent, not ``null``: absent reads back as the
    field's default, which is how "None means inherit" round-trips. A
    path-named asset writes its name first, as authored."""
    spec = info.asset_spec
    lay = spec_layout(spec)
    # ``skip_api_serializer``: the API projection (which injects ``expand`` and
    # filters to API fields) is not what the disk holds — a ``forbid`` spec
    # would reject the injected key. Python mode: the final dump does the JSON
    # conversion once.
    selected = obj.model_dump(include=set(lay.header_fields), context={"skip_api_serializer": True})
    # By alias: a spec field may carry the FILE's key (``schema`` on a manifest)
    # while the entity holds it under the row's name (``manifest_schema``).
    # ``exclude_defaults``: a default is not authored — absent reads back as the
    # default, so the file says only what the author said (a fresh doc has an
    # empty header; a counter is written only once it moved).
    # ``sectioned``: a ``SectionedHeader`` nests its section fields for the FILE only.
    out = spec.model_validate(selected).model_dump(
        mode="json", exclude_none=True, exclude_defaults=True, by_alias=True,
        exclude=lay.marker_fields, context={"sectioned": True},
    )
    if info.name_from_path and getattr(obj, "name", None):
        out = {"name": obj.name, **out}
    return out


def _observe_identity(info: Any, root: Path) -> str:
    """The id the type's backend sees at ``root`` (capsule, then legacy readers),
    or ``""``. MALFORMED raises, matching ``TypeInfo._observe``."""
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.identity_backend import IdentityState  # noqa: PLC0415

    if info is None or info.identity_backend is None:
        return ""
    obs = info._observe(FSRef(_asset_ref(info, root)))
    return str(obs.candidate) if obs is not None and obs.state is IdentityState.VALID else ""


def _commit_identity(info: Any, root: Path, obj: Any) -> str:
    """The identity step every disk store ends with: the carrier is
    authoritative, so the COMMITTED id may differ from the one proposed.
    ``carrier_writes_are_suppressed`` means the caller resolves identity
    elsewhere — return what we were given, touch nothing.

    The ref handed to ``mint_entity_id`` is the ASSET_REF the type's backend
    was registered for — the inner ``agent.md`` for a ``main_file_is_asset_ref``
    type, the folder for a bare-folder type, the file for a file type."""
    from flow_sdk.fs_store.fs_record import carrier_writes_are_suppressed  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415

    entity_id = getattr(obj, "id", None)
    if info is None or info.identity_backend is None or not entity_id:
        return str(entity_id or "")
    if carrier_writes_are_suppressed():
        return str(entity_id)
    ref = FSRef(_asset_ref(info, root))
    return str(info.mint_entity_id(ref, proposed_id=str(entity_id), derive=True, overwrite=True))


# ── the serializer ────────────────────────────────────────────────────────────

class DiskSerializer:
    kind: ClassVar[str] = "local"

    @staticmethod
    def root(origin: FSOrigin) -> Path:
        return _resolve_local_path(origin)

    # ── render ────────────────────────────────────────────────────────────

    def render(self, obj: Any, info: Any = None) -> Optional[str]:
        """The main document's TEXT, or None when the type has none. A type
        with no ``asset_spec`` renders through ``TypeInfo.default_body_fn`` (a
        template the spec vocabulary cannot express) — or nothing."""
        info = info or SchemaRegistry.get(_type_of(obj))
        if info is None or info.asset_spec is None:
            fn = info.default_body_fn if info else None
            return fn(obj) if fn is not None else None
        from flow_sdk.schema.type_info import render_entity_frontmatter  # noqa: PLC0415

        main = info.main_file if info.main_layout == "folder" else None
        if main and main.endswith(".json"):
            # A flat document IS its payload: an entity carrying no payload (a
            # metadata-only save of a report) has nothing to say — no document,
            # so an owned file is never clobbered by a summary-only render.
            free_field = spec_layout(info.asset_spec).free
            if _manifest_layout(info) == "flat" and free_field and getattr(obj, free_field, None) is None:
                return None
            return json.dumps(_manifest(obj, info), indent=2, ensure_ascii=False) + "\n"
        if info.main_layout == "folder" and not main:
            return None
        body = _body(obj, info)
        tail = f"\n\n{body}\n" if body or info.main_layout != "folder" else "\n"
        return render_entity_frontmatter(obj, _frontmatter(obj, info)) + tail

    # ── store ─────────────────────────────────────────────────────────────

    def store(self, obj: Any, origin: FSOrigin, *, type_name: Optional[str] = None, force: bool = False) -> FSOrigin:
        root = self.root(origin)
        info = SchemaRegistry.get(type_name or _type_of(obj))
        main = _main_doc(info, root)
        exists = main is not None and main.is_file()
        # ``owns_main_ref`` is the write policy: write iff the main doc is ABSENT
        # — or on every save only when the entity is the file's sole editor. A
        # DB-side save of an unowned type must never re-render a file a user
        # hand-edits (it would drop every header field the entity does not carry).
        # ``force`` is an EXPLICIT edit of the file (an action that loaded it,
        # changed one field, and is writing it back) — that is not a DB-side save.
        owns = bool(info and info.owns_main_ref) or force
        if owns or not exists:
            self._write_main(obj, info, root, main)
        if info is not None and info.asset_spec is not None:
            self._write_fields(obj, info, root)           # a spec-less type has no field layout to walk
        return origin.model_copy(update={"id": _commit_identity(info, root, obj)})

    def _write_main(self, obj: Any, info: Any, root: Path, main: Optional[Path]) -> None:
        from flow_sdk.fs_store.fs_ref import FrontMatterFsRef  # noqa: PLC0415
        from flow_sdk.fs_store.indexer._frontmatter import _atomic_write_text  # noqa: PLC0415

        if info is not None and info.main_layout == "folder":
            root.mkdir(parents=True, exist_ok=True)       # the carrier target for a FolderCapsule
        if main is None:
            return
        # Both substrates are atomic and skip a byte-identical rewrite, so a
        # no-op save never churns the mtime the hash sentinel keys on.
        if info is None or info.asset_spec is None:
            text = self.render(obj, info)
            if text is None:
                return                                    # nothing to render: the folder is the asset
            if main.exists() and main.suffix.lower() in {".md", ".markdown"}:
                from flow_sdk.capsules import restore_capsule_blocks, snapshot_capsule_blocks  # noqa: PLC0415

                text = restore_capsule_blocks(text, snapshot_capsule_blocks(main.read_text(encoding="utf-8")))
            _atomic_write_text(main, text)
        elif main.suffix == ".json":
            text = self.render(obj, info)
            if text is not None:
                _atomic_write_text(main, text)
        else:
            FrontMatterFsRef(main).write_doc(f"\n{_body(obj, info)}\n", _frontmatter(obj, info))

    def _write_fields(self, obj: Any, info: Any, root: Path) -> None:
        """Every field by its declared persistence. A sub-asset is stored through
        THIS serializer with its own origin, so it commits its own identity via
        its own TypeInfo. Rows go through the layout the manifest names."""
        fields = type(obj).model_fields
        for name, kind in field_kinds(type(obj)):
            value = getattr(obj, name, None)
            if kind is FieldKind.SUB_ASSET_LIST:
                sub_cls, _ = asset_class(fields[name].annotation)
                ext = _list_element_ext(sub_cls)
                (root / name).mkdir(parents=True, exist_ok=True)
                for item in value or []:
                    if not getattr(item, "name", None):
                        raise ValueError(f"{type(item).__name__}.name is required to place it in a directory")
                    self.store(item, local_origin_for_path(root / name / f"{item.name}{ext}"))
            elif kind is FieldKind.SUB_ASSET and value is not None:
                sub_cls, _ = asset_class(fields[name].annotation)
                self.store(value, local_origin_for_path(_sub_target(root, name, sub_cls)))
            elif kind is FieldKind.ROWS and info is not None and info.rows_layout_field:
                from flow_sdk.schema.data_spec.layout import layout_for  # noqa: PLC0415

                source = getattr(obj, "asset_ref", None)
                layout_for(getattr(obj, info.rows_layout_field)).write(
                    root, value or [], dataset_id=str(getattr(obj, "id", "") or ""),
                    field_spec=getattr(obj, "field_spec", None) or {}, delimiter=getattr(obj, "delimiter", None) or ",",
                    source=Path(source) if source else None,
                )

    # ── load ──────────────────────────────────────────────────────────────

    def load(self, cls: type, origin: FSOrigin, *, entity_id: Optional[str] = None) -> Any:
        """Identity FIRST, through the type's backend — the canonical capsule,
        then legacy carriers. MALFORMED raises. A caller-supplied ``entity_id``
        is the fallback when the carrier is absent."""
        root = self.root(origin)
        info = SchemaRegistry.get(type_default(cls)) if type_default(cls) else None
        obj = self._load_typed(cls, info, root, entity_id)
        if obj is not None and info is not None and info.main_layout == "folder" and "editors" in cls.model_fields:
            # A fact of loading a FOLDER asset, whichever path built the row
            # (a bare spec probe without the field is left alone).
            from flow_sdk.assets.asset_editors import list_asset_editors  # noqa: PLC0415

            obj.editors = list_asset_editors(root)
        return obj

    def _load_typed(self, cls: type, info: Any, root: Path, entity_id: Optional[str]) -> Any:
        if info is None or info.asset_spec is None:
            return self._load_via_parser(cls, info, root, entity_id)
        data, header_raw = self._read_main(cls, info, root)
        observed_id = _observe_identity(info, root)
        data.update(self._read_fields(cls, info, root, entity_id or observed_id, header_raw))
        if info.derive_fields_fn is not None:
            # Facts the disk carries that the spec cannot say (counts over rows,
            # links in a body, a name from the path) — before the row is built.
            info.derive_fields_fn(data, root, header_raw)
        resolved_id = observed_id or entity_id
        if resolved_id:
            data["id"] = resolved_id
        return cls(**data)

    @staticmethod
    def _load_via_parser(cls: type, info: Any, root: Path, entity_id: Optional[str]) -> Any:
        """A type with no ``asset_spec``: its ``from_disk_fn`` → record → entity."""
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415

        records = info.from_disk_fn(FSRef(root), entity_id) if info and info.from_disk_fn else []
        return Entity._build_from_fs_record(records[0], fallback_cls=cls) if records else None

    def _read_main(self, cls: type, info: Any, root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
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
        data.update(spec.model_validate(header_raw).model_dump(exclude_none=True, exclude=lay.marker_fields))
        if info.name_from_path:
            data["name"] = header_raw.get("name") or (root.name if root.is_dir() else root.stem)
        return data, header_raw

    def _read_fields(
        self, cls: type, info: Any, root: Path, entity_id: Optional[str], header_raw: dict[str, Any]
    ) -> dict[str, Any]:
        data: dict[str, Any] = {}
        fields = cls.model_fields
        for name, kind in field_kinds(cls):
            if kind is FieldKind.SUB_ASSET_LIST:
                sub_cls, _ = asset_class(fields[name].annotation)
                sub = root / name
                ext = _list_element_ext(sub_cls)
                data[name] = [self.load(sub_cls, local_origin_for_path(p)) for p in sorted(sub.glob(f"*{ext}"))] if sub.is_dir() else []
            elif kind is FieldKind.SUB_ASSET:
                sub_cls, _ = asset_class(fields[name].annotation)
                target = _sub_target(root, name, sub_cls)
                if target.exists():
                    data[name] = self.load(sub_cls, local_origin_for_path(target))
            elif kind is FieldKind.ROWS and info is not None and info.rows_layout_field:
                from flow_sdk.schema.data_spec.dataset_spec import DEFAULT_DATASET_SPEC, DataLayoutEnum  # noqa: PLC0415
                from flow_sdk.schema.data_spec.layout import coerce_dataset_enum, layout_for  # noqa: PLC0415

                # Rows are ARTIFACTS (paths, folders, cells) — never contents.
                layout = coerce_dataset_enum(header_raw.get(info.rows_layout_field), DataLayoutEnum, DataLayoutEnum.CSV)
                data[name] = layout_for(layout).read(
                    root, DEFAULT_DATASET_SPEC.example_type(), dataset_id=entity_id or "",
                    field_spec=header_raw.get("field_spec") or {}, delimiter=header_raw.get("delimiter") or ",",
                )
        return data


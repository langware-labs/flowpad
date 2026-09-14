"""``DiskSerializer`` — the ``"local"`` origin kind. HOW an asset becomes files.

Reads and writes an asset TREE driven by its ``TypeInfo``: the layout slots
(``main_layout``, ``main_file``, …) and ``asset_spec`` — the ``DataSpec`` whose
field TYPES say what the document holds (frontmatter scalars, a ``Body``, a
``FreeSection``, bytes, rows, sub-assets). Every byte goes
through the substrate that already exists — ``FrontMatterFsRef`` (atomic,
capsule-preserving), ``load_doc``/``write_doc`` for JSON manifests, a
``DatasetLayout`` for rows — and identity goes through the type's
``IdentityBackend`` via ``TypeInfo.stamp_id``. Nothing here names a
concrete asset class; dispatch is by ``FieldKind``.

A type that declares no ``asset_spec`` still goes through here: it renders via
``TypeInfo.default_body_fn`` (a ``.js`` template, a ``.csv``) and loads via
``from_disk_fn`` → record → entity. Same store policy, same identity step.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar, Optional

from flow_sdk.assets.serialization import (
    _list_element_ext,
    _read_identity,
    _sub_target,
    read_main,
    render_asset,
    write_asset_tree,
)
from flow_sdk.builtin.drivers.local_driver import _resolve_local_path
from flow_sdk.fs_store.origin.fs_origin import FSOrigin
from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer.fields import (
    FieldKind,
    asset_class,
    field_kinds,
    type_default,
)


def _type_of(obj: Any) -> str:
    """Resolve runtime Entity identity before crossing the filesystem boundary."""
    getter = getattr(obj, "get_type", None)
    return getter() if callable(getter) else type_default(type(obj))


# ── shared helpers ────────────────────────────────────────────────────────────

# ── the serializer ────────────────────────────────────────────────────────────

class DiskSerializer:
    kind: ClassVar[str] = "local"

    @staticmethod
    def root(origin: FSOrigin) -> Path:
        return _resolve_local_path(origin)

    # ── render ────────────────────────────────────────────────────────────

    def render(self, obj: Any, info: Any = None) -> Optional[str]:
        return render_asset(obj, info or SchemaRegistry.get(_type_of(obj)))

    # ── store ─────────────────────────────────────────────────────────────

    def store(self, obj: Any, origin: FSOrigin, *, type_name: Optional[str] = None, force: bool = False) -> FSOrigin:
        root = self.root(origin)
        info = SchemaRegistry.get(type_name or _type_of(obj))
        identity = write_asset_tree(obj, info, root, force=force)
        return origin.model_copy(update={"id": identity})

    # ── load ──────────────────────────────────────────────────────────────

    def load(self, cls: type, origin: FSOrigin, *, entity_id: Optional[str] = None) -> Any:
        """Identity FIRST, through the type's backend — the canonical capsule,
        then legacy carriers. MALFORMED raises. A caller-supplied ``entity_id``
        is the fallback when the carrier is absent."""
        root = self.root(origin)
        info = SchemaRegistry.get(type_default(cls)) if type_default(cls) else None
        return self._load_typed(cls, info, root, entity_id)

    def _load_typed(self, cls: type, info: Any, root: Path, entity_id: Optional[str]) -> Any:
        if info is None or info.asset_spec is None:
            return self._load_via_parser(cls, info, root, entity_id)
        data, header_raw = self._read_main(cls, info, root)
        observed_id = _read_identity(info, root)
        data.update(self._read_fields(cls, info, root, entity_id or observed_id, header_raw))
        if info.derive_fields_fn is not None:
            # Facts the disk carries that the spec cannot say (counts over rows,
            # links in a body, a name from the path) — before the row is built.
            info.derive_fields_fn(data, root, header_raw)
        if info.row_derive_fn is not None:
            info.row_derive_fn(data, root, header_raw)
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
        return read_main(info, root)

    def _read_fields(
        self, cls: type, info: Any, root: Path, entity_id: Optional[str], header_raw: dict[str, Any]
    ) -> dict[str, Any]:
        data: dict[str, Any] = {}
        fields = cls.model_fields
        for name, kind in field_kinds(cls):
            if kind is FieldKind.SUB_ASSET_LIST:
                sub_cls, _ = asset_class(fields[name].rebuild_annotation())
                sub = root / name
                ext = _list_element_ext(sub_cls)
                data[name] = [self.load(sub_cls, local_origin_for_path(p)) for p in sorted(sub.glob(f"*{ext}"))] if sub.is_dir() else []
            elif kind is FieldKind.SUB_ASSET:
                sub_cls, _ = asset_class(fields[name].rebuild_annotation())
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


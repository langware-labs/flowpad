"""Single authoring home for per-type metadata.

Each ``schema/type_info/<type>_info.py`` module declares one (or more)
``TypeMetadata`` instance at module scope. ``register_all()`` imports every
sibling module and registers their ``TypeMetadata`` into ``SchemaRegistry``.

- ``TypeMetadata`` is the *declarative authoring* shape — what you write here.
- ``TypeInfo`` (schema_registry) is the *runtime registry record* it produces.
- A specific type may subclass ``TypeMetadata`` to add type-specific fields;
  the instance is attached to the resulting ``TypeInfo.metadata`` so base
  classes can read the extras. The flat ``TypeInfo`` fields remain the single
  serialized surface (no polymorphic serialization).

Concrete entity classes carry NO type-metadata config; they only attach
``entity_cls`` via ``Entity.__init_subclass__`` (merged in by the registry).
"""
from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass, field
from typing import Any

from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.view_mode import ViewMode


@dataclass
class TypeMetadata:
    """Declarative per-type metadata. Subclass to add type-specific extras."""

    type: str
    icon: str | None = None
    # UX-friendly, human-readable label for this type — used wherever the type
    # is shown to the user as a word (e.g. the auto-bookmark folder title). Plural
    # reads best for grouping surfaces ("Skills", "Documents"). None ⇒ callers
    # fall back to ``humanize_type(type)`` (schema_registry). Presentational only —
    # NOT part of the schema hash, so relabeling never triggers a reindex.
    displayName: str | None = None
    # Minimum view mode at which this type appears in the Assets browser.
    # None ⇒ never browseable; visibility is cumulative (Standard ⊂ Advanced ⊂ Dev).
    browseable_by: ViewMode | None = None
    creatable: bool = False
    indexed_by_default: bool = False
    api_visible: bool = False
    index_fields: list[str] = field(default_factory=list)
    # Placement axis — the harness-aware replacement for the fused ``.claude/…``
    # subdir. Declare ``asset_class`` + ``family`` (+ ``harness`` for HARNESS
    # types); resolved by ``flow_sdk.fs_store.placement``. Typed ``Any`` to keep
    # this authoring module free of a placement import.
    asset_class: Any = None            # placement.AssetClass | None
    harness: Any = None                # placement.HarnessType | None
    family: str | None = None
    main_layout: str = "file"
    # Folder-layout types: inner filename of the primary asset (e.g. "spec.md"
    # under specs/<name>/, "SKILL.md" under .claude/skills/<name>/). See
    # TypeInfo.main_file.
    main_file: str | None = None
    # Folder-layout types only: does ``asset_ref`` point at the inner ``main_file``
    # (True — e.g. spec, whose indexer emits ``spec.md``) or at the containing
    # folder (False — e.g. skill, whose indexer emits the folder and whose
    # frontend resolves ``<folder>/SKILL.md`` itself)? When False, the default
    # body is materialized into ``<folder>/main_file`` while asset_ref stays the
    # folder. Ignored for ``main_layout == "file"``.
    main_file_is_asset_ref: bool = False
    # File extension for ``main_layout == "file"`` types (default ``.md``). A
    # non-markdown asset (e.g. a ``.js`` dynamic workflow) overrides it so the
    # created file matches the type's indexer glob.
    main_ext: str = ".md"
    # Per-type ADDITIONS to the base sender-local field set (see
    # ``entity_model._BASE_LOCAL_FIELDS``). These fields are host-local and never
    # travel in ``Entity.to_common_json()`` / the hub body — e.g. a
    # claude_session's ``worker_session_id`` or a task's ``project_root``. The
    # base set covers the fields common to every type; declare only the extras.
    local_fields: frozenset = field(default_factory=frozenset)
    parent_type: str | None = None
    # True ⇒ sharing an entity of this type automatically includes its parent
    # (``parent_type_id``) in the outgoing ``shared_context_entities``, and the
    # receive path materializes the parent first (see
    # ``Entity.materialize_share_parent``). Only safe when the parent type is
    # deterministic/field-frozen; a mutable parent would reintroduce cross-sender
    # ownership conflicts.
    parent_share_on_default: bool = False
    # True ⇒ this hub-hosted ``is_child`` type is pulled during the shared-context
    # catch-up sync (the live bridge already materializes any child generically via
    # ``_handle_child_op``). Makes the catch-up path registry-driven like the live
    # path, instead of a hardcoded type list. Runtime-only; not in the schema hash.
    shared_child: bool = False
    # Indexer dispatch callables (walked types only).
    from_disk_fn: Any = None
    id_from_file_fn: Any = None
    id_from_folder_fn: Any = None
    id_stable_key_fn: Any = None
    id_namespace: Any = None
    id_write_fn: Any = None
    asset_hash_fn: Any = None
    post_sync_fn: Any = None
    # Per-type default-body writer used by FSRecord.upsert_main_ref to materialize
    # the backing file on create. None ⇒ no auto-created body. Without this wired
    # through, create persists the entity + asset_ref but never writes the file
    # (the "File is missing" workflow bug).
    default_body_fn: Any = None
    # True ⇒ the entity is the sole editor of its backing file: every entity
    # save re-renders the file from ``default_body_fn`` (not just create), so
    # entity-side edits (e.g. a dialog changing frontmatter fields) reach the
    # on-disk source of truth instead of silently diverging until the next
    # rescan reverts them. Leave False for files users also edit by hand in
    # other editors (the markdown family).
    owns_main_ref: bool = False
    # Per-type pydantic metadata model — the FS↔DB schema (see TypeInfo.meta_model).
    meta_model: Any = None
    # Reception seam: when a received attachment of this type is installed, the
    # built-in skill (if any) that sets it up in a Vibe session. ``None`` ⇒ the
    # received entity is simply opened (no setup agent). The sentinel value equal
    # to ``type`` means "run the received entity as its own skill" (skill type).
    # Read by ``Entity.setup_on_receive``.
    setup_skill: str | None = None
    # Reception seam: the verb the receive UI shows for this type — the CTA label
    # is ``"<reception_verb> the <typeLabel>"`` (e.g. "Set up the app", "Run the
    # skill", "Open the note"). Declared next to the type like ``main_subdir``.
    reception_verb: str = "Open"
    # Reception seam: how a received bundle entry of this type is gated.
    # ``None`` (default) ⇒ staged → review → explicit install (the consent
    # boundary). ``"auto"`` ⇒ row-only payload with no agent-executable
    # content: unpack stages the MessageAttachment like every payload entry,
    # then installs it immediately through the one install action — no review
    # dialog, and its chip navigates instead of opening the review modal.
    receive_policy: str | None = None
    # Row-only auto types: local-state overrides merged over the packed header
    # when the row materializes on install (e.g. claude_session stamps
    # ``{"remote": False, "received": True}``). Backend-only; never serialized.
    receive_row_overrides: dict | None = None

    def to_type_info(self) -> TypeInfo:
        return TypeInfo(
            type_name=str(self.type),
            icon=self.icon,
            display_name=self.displayName,
            browseable_by=self.browseable_by,
            creatable=self.creatable,
            indexed_by_default=self.indexed_by_default,
            api_visible=self.api_visible,
            index_fields=list(self.index_fields),
            asset_class=self.asset_class,
            harness=self.harness,
            family=self.family,
            main_layout=self.main_layout,
            main_file=self.main_file,
            main_file_is_asset_ref=self.main_file_is_asset_ref,
            main_ext=self.main_ext,
            local_fields=frozenset(self.local_fields),
            parent_type=self.parent_type,
            parent_share_on_default=self.parent_share_on_default,
            shared_child=self.shared_child,
            from_disk_fn=self.from_disk_fn,
            id_from_file_fn=self.id_from_file_fn,
            id_from_folder_fn=self.id_from_folder_fn,
            id_stable_key_fn=self.id_stable_key_fn,
            **({"id_namespace": self.id_namespace} if self.id_namespace is not None else {}),
            id_write_fn=self.id_write_fn,
            asset_hash_fn=self.asset_hash_fn,
            post_sync_fn=self.post_sync_fn,
            default_body_fn=self.default_body_fn,
            owns_main_ref=self.owns_main_ref,
            meta_model=self.meta_model,
            setup_skill=self.setup_skill,
            reception_verb=self.reception_verb,
            receive_policy=self.receive_policy,
            receive_row_overrides=self.receive_row_overrides,
            locations=["index"],
            metadata=self,
        )

    def register(self) -> None:
        SchemaRegistry.register(self.to_type_info())


def render_entity_frontmatter(entity: Any, fields: dict[str, Any]) -> str:
    """Frontmatter block for a ``default_body_fn`` — ALWAYS stamps ``id`` first.

    Entity-id policy: the backing file must carry the entity's UUID, or the
    indexer cannot adopt the API-created row (validate-on-adopt rejects the
    name/stem fallback) and mints a duplicate v5-from-path entity on the next
    walk. Every md-backed ``default_body_fn`` renders through this single
    chokepoint so a new type can't re-introduce the omission.
    """
    from flow_sdk.fs_store.indexer._frontmatter import _render_frontmatter  # noqa: PLC0415

    return _render_frontmatter({"id": str(entity.id), **fields})


def register_all() -> None:
    """Import every ``*_info`` sibling module and register its TypeMetadata."""
    import flow_sdk.schema.type_info as pkg

    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        module = importlib.import_module(f"{__name__}.{mod.name}")
        for value in vars(module).values():
            if isinstance(value, TypeMetadata):
                value.register()

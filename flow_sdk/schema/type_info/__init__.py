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
import logging
import pkgutil
from dataclasses import dataclass, field, fields
from typing import Any, Literal

from flow_sdk.capsules import CapsuleSpec
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.view_mode import ViewMode

logger = logging.getLogger(__name__)


_TYPE_INFO_SLOTS = frozenset(f.name for f in fields(TypeInfo))


@dataclass
class TypeMetadata:
    """Declarative per-type metadata. Subclass to add type-specific extras."""

    type: str
    # Either a lucide export name in PascalCase ("BrainCog") or a path to a file
    # this backend serves ("icons/agent.svg"). The frontend discriminates on the
    # slash — a lucide name can never contain one — so both reach every surface
    # through the same ``iconForType`` lookup. Free string by design: the set of
    # valid lucide names lives in the frontend's bundle, not here.
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
    # Cloud transport for file-backed assets. Runtime delivery capability only;
    # it deliberately does not participate in the local indexing schema hash.
    cloud_file_transport: Literal["embedded", "git"] = "embedded"
    # True ⇒ this entity type persists only in the database. ``Entity.save``
    # skips the FSRecord guard + disk mirror entirely; there is no disk→DB adopt
    # path for the type. Runtime persistence policy, not part of the schema hash.
    db_only: bool = False
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
    # Fields the ASSIGNEE of a shared entity of this type owns. A hub-reflected
    # update written by the assignee carries ONLY these; everything else belongs
    # to whoever handed the work over. Empty ⇒ no scoping. See
    # ``_hub_reflect.scope_body_to_assignee_fields`` for why one shared row needs
    # it: whole-row LWW plus a client that PUTs its whole snapshot means a status
    # click would otherwise revert the owner's title and body.
    assignee_owned_fields: tuple = field(default_factory=tuple)
    # Files inside a folder-backed asset that never ride a share bundle (the
    # packer copies the folder verbatim). E.g. a task's inner ``spec.md``.
    pack_exclude: tuple = field(default_factory=tuple)
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
    capsules: tuple[CapsuleSpec, ...] = ()
    identity_carrier: Any = None
    id_stable_key_fn: Any = None
    id_namespace: Any = None
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
    # Serialization layout facts (see TypeInfo): the path names the entity
    # when the header does not; the field naming the rows' layout; how a JSON
    # main doc is laid out; the disk-derived facts hook.
    name_from_path: bool = False
    rows_layout_field: str | None = None
    hub_main_file: str | None = None
    manifest_layout: str | None = None
    derive_fields_fn: Any = None
    # The origin kind a store/load defaults to; None ⇒ "db" for db_only types,
    # else "local". A row-only type that is NOT db_only (SourceItem keeps its
    # shadow + FTS) declares "db" explicitly.
    default_origin_kind: str | None = None
    # Row identity + no-op gate for row-only types (see TypeInfo).
    natural_key: tuple[str, ...] | None = None
    digest_fields: tuple[str, ...] | None = None
    digest_field: str = "content_digest"
    # The type's shape — a ``DataSpec`` class (see TypeInfo.asset_spec).
    asset_spec: Any = None
    # Row-only but searchable: the row field FTS indexes as ``content``.
    fts_content: tuple[str, ...] = ()
    # Reception seam: when a received attachment of this type is installed, the
    # built-in skill (if any) that sets it up in a Vibe session. ``None`` ⇒ the
    # received entity is simply opened (no setup agent). The sentinel value equal
    # to ``type`` means "run the received entity as its own skill" (skill type).
    # Read by ``Entity.setup_on_receive``.
    setup_skill: str | None = None
    # Builtin editors for the type — SDK-shipped apps under
    # ``flow_sdk/assets/editors/<name>/`` served for EVERY entity of the type,
    # alongside whatever the asset itself ships under ``<asset>/editors/``.
    editors: list[str] = field(default_factory=list)
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

    # TypeMetadata is the authoring form of TypeInfo; the two differ only in the
    # names below. Every other slot copies by name, so a new field needs no plumbing.
    _RENAMED = {"type": "type_name", "displayName": "display_name"}

    def to_type_info(self) -> TypeInfo:
        kw = {}
        for f in fields(self):
            name = self._RENAMED.get(f.name, f.name)
            value = getattr(self, f.name)
            if name in _TYPE_INFO_SLOTS and not (name == "id_namespace" and value is None):
                kw[name] = value
        kw["type_name"] = str(kw["type_name"])
        kw["default_origin_kind"] = self.default_origin_kind or ("db" if self.db_only else "local")
        return TypeInfo(**kw, locations=["index"], metadata=self)

    def register(self) -> None:
        SchemaRegistry.register(self.to_type_info())


def render_entity_frontmatter(entity: Any, fields: dict[str, Any]) -> str:
    """Render domain frontmatter; identity is stored by ``AssetCapsule``."""
    from flow_sdk.fs_store.indexer._frontmatter import _render_frontmatter  # noqa: PLC0415

    return _render_frontmatter(fields)


def register_all() -> None:
    """Import every ``*_info`` sibling module and register its TypeMetadata.

    Each module is registered independently: a broken one (e.g. a stale
    ``*_type_info.py`` left behind by a partial upgrade that references an
    ``EntityType`` member a newer ``types.py`` has since removed) is logged and
    SKIPPED rather than aborting the whole registry. Degrading to "that one type
    is missing" keeps the server bootable — a wholesale failure here poisons
    every entity lookup (SchemaRegistry can't finish loading) and the process
    won't start. See the ``AttributeError: FLOW`` incident from a mismatched
    site-packages install.
    """
    import flow_sdk.schema.type_info as pkg

    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{mod.name}")
            for value in vars(module).values():
                if isinstance(value, TypeMetadata):
                    value.register()
        except Exception:  # noqa: BLE001 — one bad module must not wedge the registry
            logger.warning(
                "register_all: skipping type_info module %r (failed to load/register) — "
                "that type will be unavailable, but the registry stays usable. "
                "A stale/mismatched install is the usual cause.",
                mod.name,
                exc_info=True,
            )
    # Post-pass, once every entity class is complete: a spec/row mismatch RAISES.
    SchemaRegistry.check_asset_specs()

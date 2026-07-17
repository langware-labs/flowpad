"""TypeInfo per-type indexer dispatch slots.

The indexer reaches each type's parse/id/asset-hash logic through callable
slots on ``TypeInfo`` (``from_disk_fn`` / ``gen_uuid_fn`` / ``asset_hash_fn``),
registered next to their definitions in ``fs_store/indexer/functions/<type>``.
These replaced the old per-entity ``from_disk``/``gen_id``/``asset_hash``
classmethod shims (and the dead ``parser_fn`` slot).
"""
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.view_mode import ViewMode


def test_slots_excluded_from_schema_hash():
    """Runtime callables must not affect the structural schema hash."""
    base = dict(type_name="_slot_hash_probe", index_fields=["x"])
    plain = TypeInfo(**base)
    with_slots = TypeInfo(
        **base,
        from_disk_fn=lambda ref: [],
        gen_uuid_fn=lambda ref: "id",
        asset_hash_fn=lambda ref: 1.0,
    )
    assert plain.schema_hash == with_slots.schema_hash


def test_register_merge_fills_but_never_clobbers():
    """Re-register fills an unset slot but never overwrites a set one with None."""
    t = "_slot_merge_probe"
    fn_a = lambda ref: ["a"]  # noqa: E731
    gen = lambda ref: "g"  # noqa: E731

    # First registration sets from_disk_fn only.
    SchemaRegistry.register(TypeInfo(type_name=t, from_disk_fn=fn_a))
    info = SchemaRegistry.get(t)
    assert info.from_disk_fn is fn_a
    assert info.gen_uuid_fn is None

    # Second registration (e.g. entity __init_subclass__) passes no slots —
    # must NOT clobber the existing from_disk_fn with None.
    SchemaRegistry.register(TypeInfo(type_name=t, icon="Probe"))
    info = SchemaRegistry.get(t)
    assert info.from_disk_fn is fn_a
    assert info.icon == "Probe"

    # Third registration fills the previously-unset gen_uuid_fn.
    SchemaRegistry.register(TypeInfo(type_name=t, gen_uuid_fn=gen))
    info = SchemaRegistry.get(t)
    assert info.from_disk_fn is fn_a
    assert info.gen_uuid_fn is gen


def test_builtin_types_have_dispatch_slots_wired():
    """Every walked type resolves parse + id through TypeInfo slots."""
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — side-effect registration

    for t in (
        "skill", "markdown", "plan", "claude_md", "agent", "command", "task",
        "whiteboard", "spec", "workflow", "claude_session", "codex_session",
        "markdown_index", "project", "claude_memory", "claude_rules",
    ):
        info = SchemaRegistry.get(t)
        assert info is not None, f"{t}: no TypeInfo registered"
        assert info.from_disk_fn is not None, f"{t}: from_disk_fn missing"
        assert info.gen_uuid_fn is not None, f"{t}: gen_uuid_fn missing"


def test_asset_hash_fn_only_for_folder_inner_file_types():
    """Folder-backed asset types (skill, whiteboard, task) carry a custom
    asset_hash_fn; flat-file types fall back to the generic mtime hash."""
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    assert SchemaRegistry.get("skill").asset_hash_fn is not None
    assert SchemaRegistry.get("whiteboard").asset_hash_fn is not None
    assert SchemaRegistry.get("task").asset_hash_fn is not None
    assert SchemaRegistry.get("markdown").asset_hash_fn is None


def test_api_visible_round_trips_and_affects_hash():
    """api_visible is a structural field: in schema_hash + to_dict/from_dict round-trip."""
    visible = TypeInfo(type_name="_api_probe", api_visible=True)
    hidden = TypeInfo(type_name="_api_probe", api_visible=False)
    assert visible.schema_hash != hidden.schema_hash
    rt = TypeInfo.from_dict(visible.to_dict())
    assert rt.api_visible is True
    assert "api_visible" in visible.to_dict()


def test_registry_presentation_getters_read_through():
    """Registry getters are the single read path for presentation flags."""
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    # skill is api_visible + creatable + browseable (Standard) + has an icon
    assert SchemaRegistry.is_api_visible("skill") is True
    assert SchemaRegistry.get_icon("skill") == "FileBadge"
    assert SchemaRegistry.browseable_by("skill") is ViewMode.STANDARD
    assert SchemaRegistry.is_browseable_in("skill", ViewMode.STANDARD) is True
    # reclassified types: claude_memory is Advanced+ only, flowpad_diagnosis Dev only
    assert SchemaRegistry.is_browseable_in("claude_memory", ViewMode.STANDARD) is False
    assert SchemaRegistry.is_browseable_in("claude_memory", ViewMode.ADVANCED) is True
    assert SchemaRegistry.is_browseable_in("flowpad_diagnosis", ViewMode.ADVANCED) is False
    assert SchemaRegistry.is_browseable_in("flowpad_diagnosis", ViewMode.DEV) is True
    assert SchemaRegistry.is_creatable("skill") is True
    # public-entity list is derived from info.api_visible, not entity_cls deref
    assert "skill" in SchemaRegistry.get_public_entity_types()
    assert SchemaRegistry.is_public_entity("skill") is True

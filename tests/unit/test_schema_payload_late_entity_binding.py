"""A type whose entity class binds AFTER the bootstrap payload cache was built
still ships its JSON schema — the binding drops the memo.

``Trigger`` is the real case: its module is imported lazily by the server's
trigger subsystem, after the first bootstrap has assembled ``types``; without
invalidation the payload for ``trigger`` stayed ``schema: None`` for the life
of the process and every frontend ``isDbField`` on a trigger row warned.
"""

from flow_sdk.core.schema import build_all_type_payloads, invalidate_schema_cache
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo


def _payload(type_name):
    return next(p for p in build_all_type_payloads() if p["type_name"] == type_name)


def test_late_entity_binding_refreshes_the_payload_schema():
    from flow_sdk.builtin.trigger import Trigger

    SchemaRegistry._ensure_loaded()
    # Simulate the server: the payload cache is assembled before the entity is bound.
    info = SchemaRegistry.get("trigger")
    assert info is not None
    bound = info.entity_cls
    info.entity_cls = None
    invalidate_schema_cache()
    try:
        assert _payload("trigger")["schema"] is None
        # The entity module's own registration, replayed.
        SchemaRegistry.register(TypeInfo(type_name="trigger", locations=["index"], entity_cls=Trigger))
        assert len(_payload("trigger")["schema"]["properties"]) > 10
    finally:
        info.entity_cls = bound
        invalidate_schema_cache()

"""Every type's bootstrap schema lists the base fields.

The SDK reads "not in the schema" as "this server does not keep the field" and answers a test on it
without asking (``QueryFilter.forServer``). A schema missing ``id`` / ``created_date`` would drop the
sort of every page of that type — ``flow_message``'s annotated wrap serializer hid all its fields.
"""

from flow_sdk.core.schema import build_all_type_payloads
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def test_every_entity_schema_lists_the_base_fields():
    import flow_sdk.builtin.flow_message  # noqa: F401  the type that lost its fields

    SchemaRegistry._ensure_loaded()
    missing = {
        p["type_name"]: sorted({"id", "created_date", "updated_date"} - set(p["schema"]["properties"]))
        for p in build_all_type_payloads()
        if p.get("schema")
    }
    assert {t: m for t, m in missing.items() if m} == {}
    assert "flow_message" in missing

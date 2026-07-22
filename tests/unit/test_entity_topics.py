"""Phase 3 — entity writes dual-publish onto the unified bus (lean envelopes)."""
from flow_sdk.builtin.usage_report import UsageReport
from flow_sdk.topics import event_bus
from tests.conftest import async_context


@async_context
async def test_entity_lifecycle_emits_created_updated_deleted(tmp_path):
    got: list = []
    unsub = event_bus.on("entity.*", got.append, target="usage_report:*")
    try:
        report = UsageReport(name="bus-drill", period="day")
        await report.save()
        report.name = "bus-drill-2"
        await report.update()
        await report.delete()
    finally:
        unsub()

    topics = [e.topic for e in got]
    assert topics[0] == "entity.created"
    assert "entity.updated" in topics
    assert topics[-1] == "entity.deleted"
    for e in got:
        assert e.target == f"usage_report:{report.id}"
        # Lean by design: identity only, never the serialized row.
        assert set(e.data) == {"entity_type", "id"}
        assert e.data["id"] == report.id
        assert e.ctx.origin == "local_server"


@async_context
async def test_save_with_owner_carries_scope(tmp_path):
    from flow_sdk.builtin.project import Project

    got: list = []
    unsub = event_bus.on("entity.created", got.append, target="usage_report:*")
    try:
        project = Project(name="scope-holder")
        await project.save()
        report = UsageReport(name="scoped", period="day")
        await report.save(project)
    finally:
        unsub()
    assert got, "created event expected"
    assert got[-1].ctx.scope == [f"project:{project.id}"]

"""Tests for SQLite driver hardening: count/delete_entities_by_type, fts_clear, get_all filtering."""

import pytest
import pytest_asyncio
from pydantic import ValidationError

from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from sqlalchemy import text


@pytest_asyncio.fixture
async def driver(tmp_path):
    """Create an in-memory SQLite driver with tables and FTS set up."""
    db_path = str(tmp_path / "test.db")
    config = DBConfig(database=db_path)
    drv = SQLiteDBDriver(config)
    await drv.open()
    yield drv
    await drv.close()


async def _insert_entity(driver, entity_id, entity_type, name="", record_data_ref=None, indexed_content=None):
    """Helper to insert a raw entity row."""
    async with driver.session_factory() as session:
        await session.execute(text(
            "INSERT INTO entities (id, type, namespace, data, record_data_ref) "
            "VALUES (:id, :type, '', '{}', :ref)"
        ), {"id": entity_id, "type": entity_type, "ref": record_data_ref})
        await session.commit()


async def _insert_fts(driver, entity_id, entity_type, name="", content=""):
    """Helper to insert a raw FTS row."""
    async with driver.session_factory() as session:
        await session.execute(text(
            "INSERT INTO entities_fts (entity_id, type, name, title, description, content) "
            "VALUES (:id, :type, :name, '', '', :content)"
        ), {"id": entity_id, "type": entity_type, "name": name, "content": content})
        await session.commit()


async def _count_fts(driver):
    async with driver.session_factory() as session:
        result = await session.execute(text("SELECT COUNT(*) FROM entities_fts"))
        return result.scalar() or 0


async def _count_entities(driver):
    async with driver.session_factory() as session:
        result = await session.execute(text("SELECT COUNT(*) FROM entities"))
        return result.scalar() or 0


class TestDeleteEntitiesByType:
    @pytest.mark.asyncio
    async def test_delete_by_type_removes_matching(self, driver):
        """delete_entities_by_type removes all entities of the given type."""
        await _insert_entity(driver, "e1", "note", record_data_ref="note/e1")
        await _insert_entity(driver, "e2", "task", record_data_ref="task/e2")
        await _insert_fts(driver, "e1", "note", content="note content")

        deleted = await driver.delete_entities_by_type("note")

        assert deleted == 1
        # e2 (task type) should still exist
        total = await _count_entities(driver)
        assert total == 1
        # FTS row for e1 should be gone
        fts_count = await _count_fts(driver)
        assert fts_count == 0

    @pytest.mark.asyncio
    async def test_delete_by_type_deletes_all_of_type(self, driver):
        """delete_entities_by_type deletes all entities of the given type unconditionally."""
        await _insert_entity(driver, "e1", "user", record_data_ref=None)
        await _insert_entity(driver, "e2", "user", record_data_ref="user/e2")
        await _insert_entity(driver, "e3", "task", record_data_ref="task/e3")

        deleted = await driver.delete_entities_by_type("user")

        assert deleted == 2
        # task entity survives
        total = await _count_entities(driver)
        assert total == 1

    @pytest.mark.asyncio
    async def test_delete_all_entities(self, driver):
        """delete_entities_by_type(None) removes all entities."""
        await _insert_entity(driver, "e1", "user", record_data_ref=None)
        await _insert_entity(driver, "e2", "note", record_data_ref="note/e2")
        await _insert_entity(driver, "e3", "task", record_data_ref="task/e3")
        await _insert_fts(driver, "e2", "note", content="note")
        await _insert_fts(driver, "e3", "task", content="task")

        deleted = await driver.delete_entities_by_type(None)

        assert deleted == 3
        total = await _count_entities(driver)
        assert total == 0
        fts_count = await _count_fts(driver)
        assert fts_count == 0


class TestCountEntitiesByType:
    @pytest.mark.asyncio
    async def test_count_returns_correct_count(self, driver):
        """count_entities_by_type returns correct counts."""
        await _insert_entity(driver, "e1", "note", record_data_ref="note/e1")
        await _insert_entity(driver, "e2", "note", record_data_ref="note/e2")
        await _insert_entity(driver, "e3", "task", record_data_ref="task/e3")

        assert await driver.count_entities_by_type("note") == 2
        assert await driver.count_entities_by_type("task") == 1
        assert await driver.count_entities_by_type("missing") == 0
        assert await driver.count_entities_by_type(None) == 3


class TestUpdateNullCreatedBy:
    @pytest.mark.asyncio
    async def test_update_existing_row_with_null_created_by_succeeds(self, driver):
        """Regression (soc2 missing attachments): a hub-origin reflection persists
        with ``created_by=None`` — the hub stamps no owner (``initiated_by``) for
        share/diagnostics conversations, and the receiver reflects that verbatim.

        Re-saving that already-existing row to backfill fields (participants /
        title / parent during invitation-preview + bundle unpack) must UPDATE it.
        ``_update_entity`` used to treat the null ``created_by`` as a
        create-on-existing collision and raise ``... already exists``, which
        aborted the unpack so the recipient never saw the messages or their
        attachments. The row provably exists by the time we reach the update, so
        a null owner is legitimate and the update must proceed.
        """
        from flow_sdk.core.entity.entity_model import remote_reflection
        from flow_sdk.builtin.agentic_process import AgenticProcess

        p = AgenticProcess(session_id="soc2")
        # Reflect a hub-origin row: created_by stays null (no fabricated owner).
        with remote_reflection():
            await driver.save(p)
        existing = await driver.get_all(QueryFilter(type=AgenticProcess.get_type()))
        assert len(existing) == 1
        assert existing[0].created_by is None  # the reflection left it null

        # The backfill re-save (invitation-preview / bundle-unpack update path).
        p.session_id = "soc2-updated"
        updated = await driver.save(p)  # must NOT raise "... already exists"
        assert updated.session_id == "soc2-updated"

        reloaded = await driver.get_all(QueryFilter(type=AgenticProcess.get_type()))
        assert len(reloaded) == 1
        assert reloaded[0].session_id == "soc2-updated"


class TestGetAllJsonFieldFilter:
    def test_unknown_kwarg_raises(self):
        """QueryFilter(unknown_field=X) must raise, not silently drop the filter."""
        with pytest.raises(ValidationError):
            QueryFilter(worker_session_id="abc")

    @pytest.mark.asyncio
    async def test_filters_by_json_field(self, driver):
        """get_all with a JSON-field ExpressionNode must return only matching entities.

        Regression: ExpressionNode(session_id=X) was silently ignored (Pydantic dropped
        the unknown kwarg), so get_all returned all entities unfiltered.
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess

        p1 = AgenticProcess(session_id="session-A")
        p2 = AgenticProcess(session_id="session-B")
        await driver.save(p1)
        await driver.save(p2)

        results = await driver.get_all(
            QueryFilter(
                type=AgenticProcess.get_type(),
                match=ExpressionNode(session_id="session-A"),
            )
        )

        assert len(results) == 1
        assert results[0].session_id == "session-A"

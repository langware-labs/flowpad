"""Long test: SchemaRecord.discover() across all default types (real FS + isolation)."""

from __future__ import annotations

import uuid
from unittest import mock

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.fs_records.schema_record import SchemaRecord
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_store import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


@pytest.fixture(autouse=True)
def isolate_schema_dir(tmp_path):
    schema_tmp = tmp_path / "schema"
    with mock.patch("flow_sdk.fs_store.schema_registry.SCHEMA_DIR", schema_tmp):
        yield schema_tmp


def _make_skill(name: str) -> SkillRecord:
    uid = str(uuid.uuid4())
    rec = SkillRecord(id=uid, name=name, description=f"{name} description")
    rec.save()
    return rec


@pytest.mark.asyncio
@pytest.mark.timeout(120)
async def test_discover_default_types(isolate_records_root, isolate_schema_dir):
    _make_skill("alpha")
    _make_skill("beta")

    scan_results, index_results = await SchemaRecord.discover()

    skill_scan = next((r for r in scan_results if r.type_name == "skill"), None)
    skill_index = next((r for r in index_results if r.type_name == "skill"), None)

    assert skill_scan is not None, "No scan result for skill type"
    assert skill_index is not None, "No index result for skill type"
    assert skill_scan.count >= 2
    assert skill_index.indexed >= 2

    assert (isolate_schema_dir / "scan_log.jsonl").exists()
    assert (isolate_schema_dir / "index_log.jsonl").exists()

    print(
        f"[stats] discover(skill): count={skill_scan.count}, bytes={skill_scan.total_bytes}, "
        f"scan_ms={skill_scan.scan_ms}, indexed={skill_index.indexed}, index_ms={skill_index.duration_ms}"
    )

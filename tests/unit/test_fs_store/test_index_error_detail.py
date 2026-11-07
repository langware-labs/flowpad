"""An index error must reach the activity with its cause, not a placeholder.

A chart whose CHART.md frontmatter is not valid YAML fails its identity probe. The
Indexing dialog then showed "(legacy producer reported an error without detail)",
and the real ValueError was only in the backend log.
"""

from __future__ import annotations

import pytest

from flow_sdk.activity import Activity
from flow_sdk.activity.bridge import mirror_table
from flow_sdk.fs_store.indexer import reset_shared_indexer
from flow_sdk.fs_store.indexer.ndjson_stream import table_from_json
from tests.unit.test_fs_store._index_handler_fakes import FakeRequestInfo, _Handler

# The real sapora-streams frontmatter: a description wrapped past its closing quote.
BROKEN_CHART_MD = (
    "---\n"
    "name: broken-chart\n"
    'description: "How a meter connects within quota."\n'
    "  + backfill.\n"
    "format: sequence\n"
    "---\n"
)


@pytest.fixture
def captured_progress(monkeypatch):
    events: list[dict] = []

    async def capture(to_entity, flow_data) -> None:
        events.append(flow_data)

    monkeypatch.setattr("flow_sdk.core.network.resource_tracker.broadcast_progress", capture)
    reset_shared_indexer()
    yield events
    reset_shared_indexer()


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_a_chart_with_broken_frontmatter_shows_its_parse_error(captured_progress, tmp_path):
    chart = tmp_path / "docs" / "network" / "broken-chart"
    chart.mkdir(parents=True)
    (chart / "CHART.md").write_text(BROKEN_CHART_MD, encoding="utf-8")
    (chart / "chart.json").write_text('{"participants": [], "messages": []}', encoding="utf-8")

    await _Handler()._handle_fs_records_index(FakeRequestInfo({"type": "chart", "path": str(tmp_path)}))

    final = [
        ev["attributes"] for ev in captured_progress
        if ev.get("element_type") == "progress_report" and ev["attributes"].get("job_name") == "index"
    ][-1]
    table = table_from_json(final)
    act = Activity.get("index-error-detail")
    mirror_table(act, table)

    row = next(c for c in act.spec().children if c.name == "chart")
    assert row.errors, "the broken chart must count as an index error"
    error = row.errors[0]
    assert error.ref and error.ref.endswith("broken-chart"), error
    assert "did not find expected key" in error.message, error.message

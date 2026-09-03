"""Legacy producers reach the new mechanism through the bridge.

The index family was validated in a browser; these are the ones whose runs finish faster
than a poll can see, so the proof belongs here. What each asserts is the same thing: the
producer's own table reaches an ``Activity``, and the activity ENDS — a producer that
started one and never finished it would sit on the footer chip as live work forever.
"""

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from flow_sdk.activity import ActivityState, monitor
from flow_sdk.server.app import app

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest_asyncio.fixture()
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture()
def observed():
    """Every activity snapshot the monitor produced, since a fast producer's row is gone
    by the time the request returns."""
    seen: list = []
    stop = monitor.subscribe(lambda root, transition: seen.append((root.path, root.state, root.done_count)))
    yield seen
    stop()


@pytest.fixture()
def docs_root(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    for i in range(5):
        (root / f"page-{i}.md").write_text(f"# Page {i}\n\nSee [other](page-{(i + 1) % 5}.md).\n")
    return root


async def test_the_docs_scan_reports_as_its_own_activity_and_ends(client, docs_root, observed):
    """It borrows ``job_name="scan"`` so the legacy pill labels it, but it is not an index
    and must not share an address with one."""
    resp = await client.get("/api/v1/docs-graph", params={"root": str(docs_root)})
    assert resp.status_code == 200

    paths = {path for path, _state, _done in observed}
    assert "docs.scan" in paths
    assert "index" not in paths and "scan" not in paths, "it must not impersonate an index"

    assert any(state in (ActivityState.COMPLETED, ActivityState.FAILED) for _p, state, _d in observed)
    assert monitor.get("docs.scan") is None, "a finished scan must not stay on the chip"


async def test_a_failing_docs_scan_still_ends_its_activity(client, tmp_path, observed):
    """Without the guard the activity never reaches a terminal state, so the monitor keeps
    a permanently running root per scanned folder and the chip reports work that stopped."""
    missing = tmp_path / "does-not-exist"

    await client.get("/api/v1/docs-graph", params={"root": str(missing)})

    for path, _state, _done in observed:
        assert monitor.get(path) is None, f"{path} was left running after a failed scan"

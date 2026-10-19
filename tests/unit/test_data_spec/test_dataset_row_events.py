"""Rows changing is an event: every row write says ``dataset.rows.changed`` once per CALL, naming
keys and never values, so an app showing those rows re-reads instead of polling. In the server the
write emits on the bus (forwarded to the app); a writer outside it (a sync script) tells the server.
"""

from __future__ import annotations

import pytest

from flow_sdk.tags.bus import on_tag
from tests.unit.test_data_spec.test_dataset_rows_by_key import _dataset

pytestmark = pytest.mark.timeout(5)


@pytest.fixture
def heard():
    events = []
    off = on_tag("dataset.rows.changed", events.append)
    yield events
    off()


@pytest.fixture
def as_server(monkeypatch):
    from flow_sdk.tags import ws_forward

    monkeypatch.setattr(ws_forward, "_started", True)


async def test_every_row_write_says_so_once_with_keys_and_no_values(tmp_path, heard, as_server):
    d = _dataset(tmp_path)
    (numbered,) = await d.append([{"input": {"name": "Zed"}}])
    await d.append([{"key": "acme", "input": {"name": "Acme"}}])
    await d.put("bolt", {"input": {"name": "Bolt"}})
    await d.put_many([{"key": "acme", "input": {"name": "Acme Inc"}}, {"key": "core", "input": {"name": "Core"}}])
    d.rename_row("core", "core2")
    d.delete_row("bolt")
    await d.sync([{"key": "acme", "input": {"name": "Acme Inc"}}, {"key": "dyne", "input": {"name": "Dyne"}}])
    assert [(e.data["op"], e.data["keys"]) for e in heard] == [
        ("put", [numbered]), ("put", ["acme"]), ("put", ["bolt"]), ("put", ["acme", "core"]),
        ("rename", ["core", "core2"]), ("delete", ["bolt"]), ("sync", ["dyne", "0001", "core2"])]
    assert {e.target for e in heard} == {f"dataset:{d.id}"}
    assert all(set(e.data) == {"op", "keys", "count", "version"} for e in heard)   # which rows -- never what they hold
    assert "Acme" not in repr([e.data for e in heard])
    assert heard[-1].data["version"] == d.rows_version()                          # the version AFTER the write
    assert len({e.data["version"] for e in heard}) == len(heard)                  # every write moved it


async def test_the_rows_version_moves_on_any_write_and_rides_on_a_read(tmp_path, as_server):
    """The server stamps the version (an outside writer posts op and keys only)."""
    """A listener whose socket was down asks ``rows-version`` and compares: the same answer
    ``rows()`` carries, so a read stamps what was seen without a second call."""
    d = _dataset(tmp_path)
    assert d.rows_version() == ""                                                  # no rows yet: nothing to version
    await d.put("acme", {"input": {"name": "Acme"}})
    v1 = d.rows_version()
    assert v1 and d.rows_version() == v1                                           # stable while nothing moves
    (d._folder() / "rows" / "acme" / "note.txt").write_text("by hand")        # a write by ANYONE, not just Flowpad
    v2 = d.rows_version()
    assert v2 != v1
    (d._folder() / "rows" / "acme" / ".DS_Store").write_text("x")             # a hidden file is not the rows
    assert d.rows_version() == v2
    assert (await d.rows_version_action()).data == {"version": v2}


async def test_a_write_that_changes_nothing_or_is_refused_says_nothing(tmp_path, heard, as_server):
    d = _dataset(tmp_path)
    await d.put("acme", {"input": {"name": "Acme"}})
    heard.clear()
    await d.sync([{"key": "acme", "input": {"name": "Acme"}}])                  # reads the same: nothing moved
    with pytest.raises(Exception):
        await d.put_many([{"key": "acme", "input": {"name": 7}}])
    with pytest.raises(LookupError):
        d.delete_rows(["ghost"])
    assert heard == []


async def test_a_large_write_names_a_bounded_number_of_keys(tmp_path, heard, as_server, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset

    monkeypatch.setattr(Dataset, "ROWS_CHANGED_KEYS", 3)
    d = _dataset(tmp_path)
    await d.put_many([{"key": f"k{n}", "input": {"name": f"N{n}"}} for n in range(8)])
    assert heard[0].data == {"op": "put", "keys": ["k0", "k1", "k2"], "count": 8, "version": d.rows_version()}


def test_the_tag_is_forwarded_to_the_app():
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.tags.ws_forward import FORWARDED_TAG_PATTERNS

    assert Dataset.ROWS_CHANGED in FORWARDED_TAG_PATTERNS


async def test_outside_the_server_a_write_tells_the_server_and_never_fails_for_it(tmp_path, heard, monkeypatch):
    from flow_sdk.cli.commands import _common

    d = _dataset(tmp_path)
    posted = []

    class Answer:
        status_code, reason, text = 200, "OK", ""

        def json(self):
            return {"status": "success", "data": {"told": 1}}

    monkeypatch.setattr(_common, "discover_port", lambda required=True: 4321)
    monkeypatch.setattr(_common, "local_request", lambda method, url, **kw: posted.append((method, url, kw["json"])) or Answer())
    await d.put_many([{"key": "acme", "input": {"name": "Acme"}}])
    assert d.announce("put", ["acme"]) is True and posted.pop() is not None       # told, and it says so
    assert posted == [("POST", f"http://127.0.0.1:4321/api/v1/graph/dataset/{d.id}/rows-changed", {"op": "put", "keys": ["acme"], "count": 1})]
    assert heard == []                                                          # this process's bus is not the app's

    monkeypatch.setattr(_common, "discover_port", lambda required=True: None)   # no instance running
    assert d.announce("put", ["acme"]) is False
    await d.put("bolt", {"input": {"name": "Bolt"}})                            # ... and the write still lands

    def down(*_a, **_k):
        raise ConnectionError("refused")
    monkeypatch.setattr(_common, "discover_port", lambda required=True: 4321)
    monkeypatch.setattr(_common, "local_request", down)
    assert d.announce("put", ["acme"]) is False
    await d.put("core", {"input": {"name": "Core"}})
    assert sorted(r.key for r in d.read_rows()) == ["acme", "bolt", "core"]


async def test_the_server_emits_what_an_outside_writer_announces(tmp_path, heard):
    from tests.unit._graph_client import call_local

    d = _dataset(tmp_path)
    await d.save()
    told = await call_local("POST", f"dataset/{d.id}/rows-changed", {"op": "sync", "keys": ["a", "b"], "count": 2})
    assert told.status_code == 200 and told.json()["data"] == {"told": 2}
    assert [(e.target, e.data) for e in heard] == [(f"dataset:{d.id}", {"op": "sync", "keys": ["a", "b"], "count": 2, "version": d.rows_version()})]
    assert (await call_local("POST", f"dataset/{d.id}/rows-changed", {"op": "drop", "keys": ["a"]})).status_code == 400
    assert (await call_local("POST", f"dataset/{d.id}/rows-changed", {"op": "put", "keys": "a"})).status_code == 400


def test_the_typescript_client_listens_for_the_tag_python_emits():
    """One tag, two spellings: a rename on either side would leave the app listening to silence."""
    import re
    from pathlib import Path

    from flow_sdk.builtin.dataset import Dataset

    root = Path(__file__).parents[3]
    client = (root / "ts_sdk/src/entities/dataset.ts").read_text()
    assert re.search(r"DATASET_ROWS_CHANGED = '([^']+)'", client).group(1) == Dataset.ROWS_CHANGED
    assert set(re.search(r"op: ([^;]+);", client[client.index("interface DatasetRowsChange"):]).group(1).replace("'", "").split(" | ")) \
        == {"put", "delete", "rename", "sync"}


def test_the_host_reads_the_open_external_message_the_sdk_sends():
    """The app side (``ts_sdk/src/apps/host.ts``) and the host (``app-display-viewer.tsx``) share ONE
    constant for the message type -- no second spelling in the host to drift."""
    import re
    from pathlib import Path

    root = Path(__file__).parents[3]
    sdk = (root / "ts_sdk/src/apps/host.ts").read_text()
    host = (root / "ui/src/pages/flow-page/app-display-viewer.tsx").read_text()
    assert re.search(r"OPEN_EXTERNAL_MESSAGE = '([^']+)'", sdk).group(1) == "flowpad:open-external"
    assert "OPEN_EXTERNAL_MESSAGE" in host and "'flowpad:open-external'" not in host.replace("{type: 'flowpad:open-external', url}", "")


async def test_a_rule_names_its_rows_by_kind_not_by_this_machines_dataset_id(tmp_path, heard, as_server):
    """The event's scope carries the row kind, so a rule checked into a project says
    ``"scope": ["kind:<kind>"]`` -- the same file on every clone, though each has its own dataset id."""
    from flow_sdk.tags.bus import on_tag as listen

    d = _dataset(tmp_path)
    mine, others = [], []
    off = [listen("dataset.rows.changed", mine.append, scope=[f"kind:{d.row_kind}"]),
           listen("dataset.rows.changed", others.append, scope=["kind:some.other.kind"])]
    try:
        await d.put("acme", {"input": {"name": "Acme"}})
    finally:
        for stop in off:
            stop()
    assert d.row_kind and heard[0].ctx.scope == [f"kind:{d.row_kind}"]
    assert len(mine) == 1 and not others

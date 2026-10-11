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
    assert all(set(e.data) == {"op", "keys", "count"} for e in heard)          # which rows -- never what they hold
    assert "Acme" not in repr([e.data for e in heard])


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
    assert heard[0].data == {"op": "put", "keys": ["k0", "k1", "k2"], "count": 8}


def test_the_tag_is_forwarded_to_the_app():
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.tags.ws_forward import FORWARDED_TAG_PATTERNS

    assert Dataset.ROWS_CHANGED in FORWARDED_TAG_PATTERNS


async def test_outside_the_server_a_write_tells_the_server_and_never_fails_for_it(tmp_path, heard, monkeypatch):
    from flow_sdk.cli.commands import _common

    d = _dataset(tmp_path)
    posted = []

    class Answer:
        status_code = 200

    monkeypatch.setattr(_common, "discover_port", lambda required=True: 4321)
    monkeypatch.setattr(_common, "local_request", lambda method, url, **kw: posted.append((method, url, kw["json"])) or Answer())
    await d.put_many([{"key": "acme", "input": {"name": "Acme"}}])
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
    assert [(e.target, e.data) for e in heard] == [(f"dataset:{d.id}", {"op": "sync", "keys": ["a", "b"], "count": 2})]
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

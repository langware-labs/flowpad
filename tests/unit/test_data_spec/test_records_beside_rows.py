"""Records beside rows: a script reads the instance's records through ``flow_sdk.local_client``, and
a row may hold a reference to a record (an ingested email, ``ingest.source_item.id.<id>``)."""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk import local_client
from tests.unit.test_data_spec.test_row_links import _dataset, _schema

pytestmark = pytest.mark.timeout(5)


class _Answer:
    def __init__(self, status=200, body=None, text=""):
        self.status_code, self._body, self.text, self.reason = status, body, text, "Bad Request" if status >= 400 else "OK"

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


@pytest.fixture
def instance(monkeypatch):
    from flow_sdk.cli.commands import _common

    calls = []
    answers = [_Answer(body={"status": "success", "data": [{"id": "i1"}]})]
    monkeypatch.setattr(_common, "discover_port", lambda required=True: 4321)
    monkeypatch.setattr(_common, "local_request", lambda method, url, **kw: calls.append((method, url, kw)) or answers[-1])
    return calls, answers


def test_a_script_reads_records_of_a_type_with_a_filter(instance):
    calls, _ = instance
    got = local_client.graph_get("source_item", {"match": {"data_source_id": "s1"}, "limit": 50}, include_system="true")
    method, url, kw = calls[0]
    assert got == [{"id": "i1"}] and (method, url) == ("GET", "http://127.0.0.1:4321/api/v1/graph/source_item")
    assert json.loads(kw["params"]["filter"]) == {"match": {"data_source_id": "s1"}, "limit": 50}
    assert kw["params"]["include_system"] == "true" and kw["json"] is None          # a GET carries no body


def test_an_action_is_posted_and_search_reads_the_index(instance):
    calls, answers = instance
    local_client.graph_post("data_source/s1/items", {"limit": 20})
    assert calls[0][:2] == ("POST", "http://127.0.0.1:4321/api/v1/graph/data_source/s1/items") and calls[0][2]["json"] == {"limit": 20}
    answers.append(_Answer(body={"status": "success", "data": {"results": [{"record_id": "r"}], "total": 1}}))
    assert local_client.search("pricing", limit=5)["total"] == 1
    assert calls[1][1].endswith("/api/v1/search") and calls[1][2]["params"] == {"q": "pricing", "limit": "5"}


def test_a_refusal_raises_with_the_servers_reasons_and_no_instance_says_so(instance, monkeypatch):
    from flow_sdk.cli.commands import _common

    _, answers = instance
    answers.append(_Answer(400, {"status": "FAIL", "message": "filter: an object is required", "data": {"errors": ["x"]}}))
    with pytest.raises(local_client.LocalError) as refused:
        local_client.graph_get("dataset/d1/rows", {"match": 3})
    assert (refused.value.status, refused.value.data) == (400, {"errors": ["x"]}) and "an object is required" in str(refused.value)
    answers.append(_Answer(200, {"status": "fail", "message": "no"}))               # a plain route's fail, answered 200
    with pytest.raises(local_client.LocalError):
        local_client.graph_get("x")
    answers.append(_Answer(502, None, "<html>gate</html>"))
    with pytest.raises(local_client.LocalError, match="gate"):
        local_client.graph_get("x")
    monkeypatch.setattr(_common, "discover_port", lambda required=True: None)
    with pytest.raises(local_client.NotRunning):
        local_client.graph_get("source_item")


async def test_a_row_may_link_to_a_record(tmp_path):
    from flow_sdk.datasets.links import record_type_of
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestrec" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.touch", {"what": {"shape": "string", "description": "x"},
                                    "email": {"shape": "?ingest.source_item", "description": "The email it was counted from."}})
    assert not any(load_root(root).values())
    touches = _dataset(root, "touches", f"--{ns}--.crm.touch")
    assert record_type_of("ingest.source_item") == "source_item" and record_type_of(f"--{ns}--.crm.touch") is None
    ref = "ingest.source_item.id.0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c"
    await touches.put("t1", {"input": {"what": "reply", "email": ref}})             # a record lives in the instance: not judged from disk
    assert touches.row("t1")["input"]["email"] == ref
    assert touches.check({"input": {"what": "x", "email": "crm.touch.id.0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c"}})   # another kind is still refused
    _dataset(root, "promoted-items", "ingest.source_item")                                   # promoted items beside: still not checked against THEM
    assert touches.check({"input": {"what": "reply", "email": ref}}) == []
    assert touches.query({"input.email": ref})["total"] == 1
    assert touches.query({"key": "t1"}, expand=["input.email"])["linked"] == {}     # from disk a record is not read (the server expands it)

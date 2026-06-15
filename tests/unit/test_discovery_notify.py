"""Tests for flow_sdk.discovery.notify envelope fields."""

import json

import flow_sdk.discovery.notify as notify
from flow_sdk.fs_store import ResourceType, SyncOperation
from flow_sdk.fs_store.record_types import RecordType


def _setup_notify_monkeypatch(monkeypatch):
    captured: dict = {}

    monkeypatch.setattr(notify, "is_webhook_rate_limited", lambda: False)
    monkeypatch.setattr(notify, "_get_report_urls", lambda: ["http://localhost:9999/hook"])

    def _capture(urls: list[str], data: bytes, log_context: str, wait: bool = False):
        captured["url"] = urls[0] if urls else None
        captured["data"] = data
        captured["log_context"] = log_context

    # send_resource_sync dispatches batched through _dispatch_to_urls (one daemon
    # thread per notification, all URLs in the loop) — patch that seam, not the
    # now-bypassed per-URL _send_fire_and_forget wrapper.
    monkeypatch.setattr(notify, "_dispatch_to_urls", _capture)
    return captured


def test_send_resource_sync_includes_resource_type(monkeypatch):
    captured = _setup_notify_monkeypatch(monkeypatch)

    queued = notify.send_resource_sync(
        type=RecordType.TASK,
        id="task-1",
        operation=SyncOperation.CREATE,
        data={"id": "task-1", "type": RecordType.TASK},
        resource_type=ResourceType.ENTITY,
    )

    assert queued is True
    payload = json.loads(captured["data"].decode("utf-8"))
    webhook_payload = payload["webhook_payload"]
    assert webhook_payload["resource_type"] == "entity"
    assert webhook_payload["type"] == "task"
    assert webhook_payload["operation"] == "create"


def test_send_entity_sync_with_relationship_resource_type(monkeypatch):
    captured = _setup_notify_monkeypatch(monkeypatch)

    queued = notify.send_entity_sync(
        operation=SyncOperation.CREATE,
        data={
            "id": "child:task:task-1:agentic_process:proc-1",
            "type": "child",
            "from_ref": {"id": "task-1", "type": "task"},
            "to_ref": {"id": "proc-1", "type": "agentic_process"},
        },
        resource_type=ResourceType.RELATIONSHIP,
    )

    assert queued is True
    payload = json.loads(captured["data"].decode("utf-8"))
    webhook_payload = payload["webhook_payload"]
    assert webhook_payload["resource_type"] == "relationship"
    assert webhook_payload["type"] == "child"
    assert webhook_payload["operation"] == "create"
    assert webhook_payload["data"]["from_ref"]["id"] == "task-1"
    assert webhook_payload["data"]["to_ref"]["id"] == "proc-1"


def test_send_log_event(monkeypatch):
    captured = _setup_notify_monkeypatch(monkeypatch)

    queued = notify.send_log_event("test_event", {"key": "value"})

    assert queued is True
    payload = json.loads(captured["data"].decode("utf-8"))
    webhook_payload = payload["webhook_payload"]
    assert webhook_payload["type"] == "log"
    assert webhook_payload["operation"] == "event"
    assert webhook_payload["data"]["event_name"] == "test_event"
    assert webhook_payload["data"]["event_data"]["key"] == "value"


def test_send_flow_tag(monkeypatch):
    captured = _setup_notify_monkeypatch(monkeypatch)

    flow_data = {"element_type": "chat", "data_type": "string", "flow_value": "hello"}
    queued = notify.send_flow_tag(flow_data)

    assert queued is True
    payload = json.loads(captured["data"].decode("utf-8"))
    webhook_payload = payload["webhook_payload"]
    assert webhook_payload["data"]["event_name"] == "flow_tag"
    assert webhook_payload["data"]["event_data"]["element_type"] == "chat"


def test_xml_str_to_flow_data_dict():
    xml = '<flow-chat i="5" t="2026-01-01" data-type="string">Hello</flow-chat>'
    result = notify.xml_str_to_flow_data_dict(xml)

    assert result["element_type"] == "chat"
    assert result["index"] == 5
    assert result["created_time"] == "2026-01-01"
    assert result["data_type"] == "string"
    assert result["flow_value"] == "Hello"


def test_xml_str_to_flow_data_dict_json():
    xml = '<flow-data data-type="json">{"key": "value"}</flow-data>'
    result = notify.xml_str_to_flow_data_dict(xml)

    assert result["element_type"] == "data"
    assert result["data_type"] == "json"
    assert result["flow_value"] == {"key": "value"}


def test_xml_str_to_flow_data_dict_invalid():
    import pytest
    with pytest.raises(ValueError, match="Expected a flow-\\* element"):
        notify.xml_str_to_flow_data_dict("<div>test</div>")


def test_send_resource_sync_rate_limited(monkeypatch):
    monkeypatch.setattr(notify, "is_webhook_rate_limited", lambda: True)
    queued = notify.send_resource_sync(
        type="task", id="1", operation=SyncOperation.CREATE, data={}
    )
    assert queued is False


def test_send_resource_sync_no_server(monkeypatch):
    monkeypatch.setattr(notify, "is_webhook_rate_limited", lambda: False)
    monkeypatch.setattr(notify, "_get_report_urls", lambda: [])
    queued = notify.send_resource_sync(
        type="task", id="1", operation=SyncOperation.CREATE, data={}
    )
    assert queued is False

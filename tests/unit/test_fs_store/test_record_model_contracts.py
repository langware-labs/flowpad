"""Record-model contracts: the id-less save refusal, status filtering on a
status-less record, and the fs-records route surfacing a failed DB sync.

Each of these used to fail silently in a different way — a fingerprint minted
as an id, an AttributeError from a filter, a DEBUG line for a missing DB row.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_query import RecordQuery
from flow_sdk.responses.response import ApiSuccessResponse

# ── D3: an id-less record never reaches disk ─────────────────────────────


def test_save_without_id_raises_instead_of_minting_a_fingerprint(tmp_records_root):
    rec = FSRecord(type="markdown", name="orphan")
    with pytest.raises(ValueError, match="mint through TypeInfo.mint_entity_id"):
        rec.save()
    assert rec.id is None, "the failed save must not have assigned an id"
    assert not any(tmp_records_root.rglob("metadata.json"))


def test_save_metadata_without_id_raises_too(tmp_records_root):
    with pytest.raises(ValueError, match="save_metadata"):
        FSRecord(type="markdown").save_metadata({"name": "x"})


def test_save_with_a_minted_id_writes_the_shadow(tmp_records_root):
    rid = mint_uuid()
    path = FSRecord(type="markdown", id=rid, name="ok").save()
    assert path.exists()
    assert path.parent.name == rid


# ── D2: RecordQuery reads only what FSRecord has ────────────────────────


def test_status_filter_on_a_status_less_record_does_not_raise():
    rec = FSRecord(type="markdown", id=mint_uuid(), name="no-status")
    assert RecordQuery(status="active").matches(rec) is False
    assert RecordQuery(status=["active", "done"]).matches(rec) is False


def test_status_filter_matches_a_record_that_carries_status():
    rec = FSRecord(type="task", id=mint_uuid(), status="active")
    assert RecordQuery(status="active").matches(rec) is True
    assert RecordQuery(status=["done"]).matches(rec) is False


def test_record_query_has_no_parent_id_field():
    assert "parent_id" not in RecordQuery.__dataclass_fields__
    with pytest.raises(TypeError):
        RecordQuery(parent_id="p1")  # type: ignore[call-arg]


# ── D4: record_error rows carry a policy-minted id ──────────────────────


def test_record_error_id_is_minted_through_the_policy_seam():
    from flow_sdk.fs_store.operations.record_error import from_exception

    err = from_exception(FSRecord(type="markdown", id=mint_uuid()), RuntimeError("boom"))
    assert is_valid_entity_id(err.id)


# ── Envelope: warnings ride on a SUCCESS response ───────────────────────


def test_envelope_serializes_warnings_only_when_present():
    plain = ApiSuccessResponse(data={"a": 1}).model_dump()
    assert "warnings" not in plain
    warned = ApiSuccessResponse(
        data={"a": 1}, warnings=[{"error_code": "index_sync_failed", "message": "m"}]
    ).model_dump()
    assert warned["status"] == "SUCCESS"
    assert warned["warnings"][0]["error_code"] == "index_sync_failed"


# ── D1: the fs-records route surfaces a failed sync_to_db ───────────────


class _Handler:
    """The mixin's CRUD gateway with the WS/asset side effects stubbed out."""

    from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin as _Mixin

    _fs_records_action = _Mixin._fs_records_action
    _index_sync_warning = _Mixin._index_sync_warning
    _parse_record_query = _Mixin._parse_record_query

    def __init__(self) -> None:
        self.broadcasts: list[tuple[str, str, str]] = []

    async def _broadcast_fs_record_op(self, op, record_type, uid, data=None, **_):
        self.broadcasts.append((op, record_type, uid))

    async def _materialize_main_body(self, rec, record_type):
        return None


def _request(monkeypatch, *, method: str, sub_path: str, body: dict | None):
    import flow_sdk.builtin.faas.fs_records_actions as mod

    async def _post_data():
        return body

    ri = SimpleNamespace(
        request=SimpleNamespace(query_params={}),
        sub_path=sub_path,
        method=method,
        get_post_data=_post_data,
    )
    monkeypatch.setattr(mod, "get_current_request_info", lambda: ri)


def _sync_raises(monkeypatch):
    async def _boom(self, *a, **k):
        raise RuntimeError("database is unavailable")

    monkeypatch.setattr(FSRecord, "sync_to_db", _boom)


@pytest.mark.asyncio
async def test_create_reports_index_sync_failure_as_a_warning(tmp_records_root, monkeypatch, caplog):
    _sync_raises(monkeypatch)
    rid = mint_uuid()
    _request(monkeypatch, method="post", sub_path="markdown", body={"id": rid, "name": "n"})
    handler = _Handler()

    with caplog.at_level("WARNING"):
        resp = await handler._fs_records_action()

    dumped = resp.model_dump()
    assert dumped["status"] == "SUCCESS", "the shadow was written; the client must not treat this as a failure"
    assert dumped["data"]["id"] == rid
    (warning,) = dumped["warnings"]
    assert warning["error_code"] == "index_sync_failed"
    assert warning["type"] == "markdown" and warning["id"] == rid
    assert "database is unavailable" in warning["message"]
    assert any(
        r.levelname == "WARNING" and "sync_to_db failed" in r.getMessage() and rid in r.getMessage()
        for r in caplog.records
    ), "the failure must be logged at WARNING with the type and id"
    assert handler.broadcasts == [("create", "markdown", rid)]


@pytest.mark.asyncio
async def test_update_reports_index_sync_failure_as_a_warning(tmp_records_root, monkeypatch):
    rid = mint_uuid()
    FSRecord(type="markdown", id=rid, name="before").save()
    _sync_raises(monkeypatch)
    _request(monkeypatch, method="put", sub_path=f"markdown/{rid}", body={"name": "after"})

    resp = await _Handler()._fs_records_action()

    dumped = resp.model_dump()
    assert dumped["status"] == "SUCCESS"
    assert dumped["data"]["name"] == "after"
    assert dumped["warnings"][0]["error_code"] == "index_sync_failed"


@pytest.mark.asyncio
async def test_create_with_a_healthy_sync_carries_no_warnings(tmp_records_root, monkeypatch):
    async def _ok(self, *a, **k):
        return None

    monkeypatch.setattr(FSRecord, "sync_to_db", _ok)
    _request(monkeypatch, method="post", sub_path="markdown", body={"id": mint_uuid(), "name": "n"})

    dumped = (await _Handler()._fs_records_action()).model_dump()
    assert dumped["status"] == "SUCCESS"
    assert "warnings" not in dumped


@pytest.mark.asyncio
async def test_create_without_an_id_mints_one(tmp_records_root, monkeypatch):
    """The route mints for a record born over HTTP — it has no file to derive
    from, so the minter's no-key (v4) form applies. What it must never do is
    fall back to the content fingerprint FSRecord.save() now refuses."""
    _request(monkeypatch, method="post", sub_path="markdown", body={"name": "no-id"})

    resp = await _Handler()._fs_records_action()
    dumped = resp.model_dump()

    assert dumped["status"] == "SUCCESS"
    assert is_valid_entity_id(dumped["data"]["id"])
    assert any(tmp_records_root.rglob("metadata.json"))


@pytest.mark.asyncio
async def test_create_with_a_foreign_id_normalizes_it(tmp_records_root, monkeypatch):
    """A hand-authored v7 never becomes an entity id: it is normalized to a
    stable v5, the same order `Entity.allocate_id` uses on the row side."""
    foreign = "018f8c8a-7a4e-7c3e-8b1a-2f6d4e5a9c11"
    _request(monkeypatch, method="post", sub_path="markdown", body={"id": foreign, "name": "v7"})

    dumped = (await _Handler()._fs_records_action()).model_dump()

    assert dumped["status"] == "SUCCESS"
    minted = dumped["data"]["id"]
    assert minted != foreign
    assert is_valid_entity_id(minted)


@pytest.mark.asyncio
async def test_create_with_a_conforming_id_adopts_it(tmp_records_root, monkeypatch):
    rid = mint_uuid()
    _request(monkeypatch, method="post", sub_path="markdown", body={"id": rid, "name": "ok"})

    dumped = (await _Handler()._fs_records_action()).model_dump()

    assert dumped["data"]["id"] == rid

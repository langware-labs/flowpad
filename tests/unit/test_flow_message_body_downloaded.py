"""Unit tests for the transient ``body_downloaded`` signal derived in
``FlowMessage._serialize_with_local_paths``.

Contract (docs/conversation/attachments.md §4.3 / §8):
  * A message serializes ``body_downloaded=true`` iff it has a body AND every
    *renderable* body attachment is present locally — files have a resolved
    ``local_path``, TYPE_ID entity assets have a materialized record folder.
  * Structural / non-materializing TYPE_IDs (conversation/flow_message/task/
    claude_session) never gate it.
  * It is API-only: never emitted under ``skip_api_serializer``.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    FlowMessage,
)
from flow_sdk.fs_store import record_paths


@pytest.fixture
def records_root(tmp_path, monkeypatch):
    """Redirect the records root the serializer probes for TYPE_ID materialization."""
    root = tmp_path / "records"
    root.mkdir()
    monkeypatch.setattr(record_paths, "get_default_records_root", lambda: root)
    return root


def _materialize(root, etype: str, eid: str) -> None:
    # Shadow store: bare id under a <type>/ parent (records/<type>/<id>/).
    folder = root / etype / eid
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "metadata.json").write_text("{}")


def _skill_attachment(eid: str) -> Attachment:
    return Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"skill-{eid}")


def test_text_only_message_is_not_downloaded(records_root):
    fm = FlowMessage(id=str(uuid.uuid4()), text="hi")
    assert fm.model_dump()["body_downloaded"] is False


def test_entity_attachment_not_materialized_is_not_downloaded(records_root):
    eid = str(uuid.uuid4())
    fm = FlowMessage(id=str(uuid.uuid4()), text="here", attachment=[_skill_attachment(eid)])
    assert fm.model_dump()["body_downloaded"] is False


def test_entity_attachment_materialized_is_downloaded(records_root):
    eid = str(uuid.uuid4())
    _materialize(records_root, "skill", eid)
    fm = FlowMessage(id=str(uuid.uuid4()), text="here", attachment=[_skill_attachment(eid)])
    assert fm.model_dump()["body_downloaded"] is True


def test_entity_attachment_staged_counts_as_downloaded(records_root, tmp_path, monkeypatch):
    """Staged reception: an entity attachment whose bytes sit in the message's
    unpacked/ staging dir counts as downloaded even though NO record folder
    exists (install may never happen — that's the user's choice, and the
    catch-up loop must not re-pull the bundle forever). Also asserts the
    transient ``body_unpacked`` flag flips with the staging dir."""
    from flow_sdk.fs_store.operations import flow_message as fm_data_ops

    data_root = tmp_path / "records_data"
    monkeypatch.setattr(record_paths, "get_default_records_data_root", lambda: data_root)

    eid = str(uuid.uuid4())
    fm_id = str(uuid.uuid4())
    fm = FlowMessage(id=fm_id, text="here", attachment=[_skill_attachment(eid)])
    assert fm.model_dump()["body_downloaded"] is False
    assert fm.model_dump()["body_unpacked"] is False

    # Stage the entry (what unpack_bundle persists) — no record folder minted.
    fm_data_ops.unpacked_dir(fm_id).mkdir(parents=True)
    (fm_data_ops.unpacked_dir(fm_id) / "header.json").write_text("{}")
    entry = fm_data_ops.staged_entry_dir(fm_id, f"skill-{eid}")
    entry.mkdir(parents=True)
    (entry / "SKILL.md").write_text("# staged")

    dumped = fm.model_dump()
    assert dumped["body_downloaded"] is True
    assert dumped["body_unpacked"] is True
    assert fm.is_body_downloaded() is True  # disk-probe twin stays in sync


def test_one_unmaterialized_entity_pegs_message_not_downloaded(records_root):
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    _materialize(records_root, "skill", a)  # only one of the two landed
    fm = FlowMessage(
        id=str(uuid.uuid4()),
        text="here",
        attachment=[_skill_attachment(a), _skill_attachment(b)],
    )
    assert fm.model_dump()["body_downloaded"] is False


@pytest.mark.parametrize("etype", ["task", "conversation", "flow_message", "claude_session"])
def test_non_materializing_type_ids_do_not_gate(records_root, etype):
    """A message whose only TYPE_ID is structural plumbing is "downloaded"
    immediately — there is no file-backed asset to pull for those."""
    fm = FlowMessage(
        id=str(uuid.uuid4()),
        text="here",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{etype}-{uuid.uuid4()}")],
    )
    assert fm.model_dump()["body_downloaded"] is True


def test_body_downloaded_is_not_emitted_for_db_storage(records_root):
    """``skip_api_serializer`` is the DB-storage path — the transient field must
    never leak into a stored row (same discipline as ``local_path``)."""
    fm = FlowMessage(id=str(uuid.uuid4()), text="here", attachment=[_skill_attachment(str(uuid.uuid4()))])
    stored = fm.model_dump(context={"skip_api_serializer": True})
    assert "body_downloaded" not in stored


def test_session_carrier_attachment_never_gates_download(records_root):
    """[LIVE-SESSION] A ``remote_worker_session-<id>`` TYPE_ID carrier is a
    non-materializing type (entity ROW only, never a record folder): it must
    not peg the message behind the Download button, alone or alongside a
    materialized asset."""
    sid = str(uuid.uuid4())
    carrier = Attachment(
        attachment_type=AttachmentType.TYPE_ID, data=f"remote_worker_session-{sid}"
    )
    fm = FlowMessage(id=str(uuid.uuid4()), text="turn", attachment=[carrier])
    assert fm.model_dump()["body_downloaded"] is True

    # Carrier + a materialized asset: still downloaded (the carrier is ignored).
    eid = str(uuid.uuid4())
    _materialize(records_root, "skill", eid)
    fm2 = FlowMessage(
        id=str(uuid.uuid4()), text="turn",
        attachment=[carrier, _skill_attachment(eid)],
    )
    assert fm2.model_dump()["body_downloaded"] is True

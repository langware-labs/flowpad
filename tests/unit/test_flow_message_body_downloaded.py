"""Unit tests for the transient ``body_downloaded`` signal derived in
``FlowMessage._serialize_with_local_paths``.

Contract (docs/collab/messages-and-attachments.md):
  * A body is downloaded when its bundle is unpacked OR all assets are local.
    Missing assets are reported separately, including on partial downloads.
  * Structural / non-materializing TYPE_IDs (conversation/flow_message/task/
    remote_worker_session) never gate it.
  * It is API-only: never emitted under ``skip_api_serializer``.
"""

from __future__ import annotations

import json
import zipfile

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    FlowMessage,
)
from flow_sdk.fs_store import record_paths
from flow_sdk.fs_store.operations import flow_message as fm_data_ops


@pytest.fixture
def records_root(tmp_path, monkeypatch):
    """Redirect the records root the serializer probes for TYPE_ID materialization."""
    root = tmp_path / "records"
    root.mkdir()
    monkeypatch.setattr(record_paths, "get_default_records_root", lambda: root)
    monkeypatch.setattr(record_paths, "get_default_records_data_root", lambda: tmp_path / "records_data")
    return root


def _materialize(root, etype: str, eid: str) -> None:
    # Shadow store: bare id under a <type>/ parent (records/<type>/<id>/).
    folder = root / etype / eid
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "metadata.json").write_text("{}")


def _skill_attachment(eid: str) -> Attachment:
    return Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"skill-{eid}")


def test_text_only_message_is_not_downloaded(records_root):
    fm = FlowMessage(id=mint_uuid(), text="hi")
    assert fm.model_dump()["body_downloaded"] is False


def test_entity_attachment_not_materialized_is_not_downloaded(records_root):
    eid = mint_uuid()
    fm = FlowMessage(id=mint_uuid(), text="here", attachment=[_skill_attachment(eid)])
    assert fm.model_dump()["body_downloaded"] is False


def test_entity_attachment_materialized_is_downloaded(records_root):
    eid = mint_uuid()
    _materialize(records_root, "skill", eid)
    fm = FlowMessage(id=mint_uuid(), text="here", attachment=[_skill_attachment(eid)])
    assert fm.model_dump()["body_downloaded"] is True


def test_entity_attachment_staged_counts_as_downloaded(records_root):
    """Staged reception: an entity attachment whose bytes sit in the message's
    unpacked/ staging dir counts as downloaded even though NO record folder
    exists (install may never happen — that's the user's choice, and the
    catch-up loop must not re-pull the bundle forever). Also asserts the
    transient ``body_unpacked`` flag flips with the staging dir."""
    eid = mint_uuid()
    fm_id = mint_uuid()
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
    a, b = mint_uuid(), mint_uuid()
    _materialize(records_root, "skill", a)  # only one of the two landed
    fm = FlowMessage(
        id=mint_uuid(),
        text="here",
        attachment=[_skill_attachment(a), _skill_attachment(b)],
    )
    assert fm.model_dump()["body_downloaded"] is False


@pytest.mark.parametrize("etype", ["task", "conversation", "flow_message"])
def test_non_materializing_type_ids_do_not_gate(records_root, etype):
    """A message whose only TYPE_ID is structural plumbing is "downloaded"
    immediately — there is no file-backed asset to pull for those."""
    fm = FlowMessage(
        id=mint_uuid(),
        text="here",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{etype}-{mint_uuid()}")],
    )
    assert fm.model_dump()["body_downloaded"] is True


@pytest.mark.parametrize("etype", ["claude_session", "codex_session", "copilot_session"])
def test_worker_session_gates_download_until_its_transcript_lands(records_root, etype):
    """A worker session IS its transcript file, so it is body-bearing: nothing
    on disk ⇒ NOT downloaded.

    It used to sit in ``_NON_MATERIALIZING_TYPE_IDS``, which made a message
    report ``body_downloaded=true`` with no transcript anywhere — hiding the
    Download affordance and telling the catch-up loop there was nothing left to
    pull. A bare row (metadata.json, no source file) is a stub and must not
    count either — same contract as spec/markdown/plan."""
    eid = mint_uuid()
    fm = FlowMessage(
        id=mint_uuid(),
        text="here",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"{etype}-{eid}")],
    )
    assert fm.model_dump()["body_downloaded"] is False

    # A stub record folder (no backing transcript) still does not count.
    _materialize(records_root, etype, eid)
    assert fm.model_dump()["body_downloaded"] is False


def test_body_downloaded_is_not_emitted_for_db_storage(records_root):
    """``skip_api_serializer`` is the DB-storage path — the transient field must
    never leak into a stored row (same discipline as ``local_path``)."""
    fm = FlowMessage(id=mint_uuid(), text="here", attachment=[_skill_attachment(mint_uuid())])
    stored = fm.model_dump(context={"skip_api_serializer": True})
    assert "body_downloaded" not in stored
    assert "body_missing_attachments" not in stored
    assert "body_unpacked" not in stored


@pytest.mark.parametrize("header_name", ["header.json", "flow_message.json"])
def test_partial_bundle_stays_downloaded_as_assets_disappear_and_return(records_root, header_name):
    available_id, missing_id = mint_uuid(), mint_uuid()
    _materialize(records_root, "skill", available_id)
    missing = Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"flowpad_diagnosis-{missing_id}")
    fm = FlowMessage(id=mint_uuid(), text="Report", attachment=[_skill_attachment(available_id), missing])
    assert not fm.is_body_downloaded()
    root = fm_data_ops.unpacked_dir(fm.id)
    root.mkdir(parents=True)
    (root / header_name).write_text(json.dumps({"id": fm.id}))

    dumped = fm.model_dump()
    assert dumped["body_downloaded"] is True
    assert dumped["body_unpacked"] is True
    assert dumped["body_missing_attachments"] == [{"attachment_type": "type_id", "data": missing.data}]
    assert fm.is_body_downloaded() is True

    _materialize(records_root, "flowpad_diagnosis", missing_id)
    assert fm.model_dump()["body_missing_attachments"] == []
    (records_root / "flowpad_diagnosis" / missing_id / "metadata.json").unlink()
    assert fm.is_body_downloaded() is True
    assert fm.model_dump()["body_missing_attachments"] == dumped["body_missing_attachments"]


def test_raw_zip_alone_is_not_an_unpacked_download(records_root):
    fm = FlowMessage(id=mint_uuid(), text="Report", attachment=[_skill_attachment(mint_uuid())])
    root = fm_data_ops.download_dir(fm.id)
    root.mkdir(parents=True)
    (root / "body.flowmsg").write_bytes(b"interrupted or invalid archive")
    assert fm.model_dump()["body_downloaded"] is False
    assert fm.is_body_downloaded() is False


def test_partial_bundle_reports_missing_files_without_exposing_stale_paths(records_root):
    fm = FlowMessage(id=mint_uuid(), text="Report", attachment=[
        Attachment(attachment_type=AttachmentType.FILE, data="files/missing.txt", local_path="/stale/path"),
        Attachment(attachment_type=AttachmentType.PROMPT, data="prompt/missing.md"),
        Attachment(attachment_type=AttachmentType.PROMPT, data="Inline prompt"),
    ])
    root = fm_data_ops.unpacked_dir(fm.id)
    root.mkdir(parents=True)
    (root / "flow_message.json").write_text(json.dumps({"id": fm.id}))
    dumped = fm.model_dump()
    assert dumped["body_downloaded"] is True
    assert fm.is_body_downloaded() is True
    assert dumped["body_missing_attachments"] == [
        {"attachment_type": "file", "data": "files/missing.txt"},
        {"attachment_type": "prompt", "data": "prompt/missing.md"},
    ]
    assert all(not att.get("local_path") for att in dumped["attachment"])


@pytest.mark.asyncio
@pytest.mark.parametrize("header_name", ["header.json", "flow_message.json"])
async def test_header_only_body_unpacks_into_existing_message(records_root, tmp_path, header_name):
    """The reported failure: existing inbox header + bundle with no asset payload."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message_bundle import unpack_bundle

    conv = await Conversation(id=mint_uuid(), title="Partial body test").save()
    ref = f"flowpad_diagnosis-{mint_uuid()}"
    fm = await FlowMessage(
        id=mint_uuid(), conversation_id=conv.id, text="Diagnostic report",
        is_read=True, attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=ref)],
    ).save()
    zip_path = tmp_path / "partial.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr(header_name, json.dumps({
            "id": fm.id, "conversation_id": conv.id, "text": fm.text,
            "attachment": [{"attachment_type": "type_id", "data": ref}],
        }))
    for _ in range(2):
        received = await unpack_bundle(zip_path, "local")
        assert received.id == fm.id
        assert received.is_read is True
        assert received.model_dump()["body_downloaded"] is True
        assert received.model_dump()["body_missing_attachments"] == [{"attachment_type": "type_id", "data": ref}]
    refreshed = await Conversation.get_one({"id": conv.id})
    assert len(json.loads(refreshed.message_ids)) == 1


def test_session_carrier_attachment_never_gates_download(records_root):
    """[LIVE-SESSION] A ``remote_worker_session-<id>`` TYPE_ID carrier is a
    non-materializing type (entity ROW only, never a record folder): it must
    not peg the message behind the Download button, alone or alongside a
    materialized asset."""
    sid = mint_uuid()
    carrier = Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"remote_worker_session-{sid}")
    fm = FlowMessage(id=mint_uuid(), text="turn", attachment=[carrier])
    assert fm.model_dump()["body_downloaded"] is True

    # Carrier + a materialized asset: still downloaded (the carrier is ignored).
    eid = mint_uuid()
    _materialize(records_root, "skill", eid)
    fm2 = FlowMessage(
        id=mint_uuid(),
        text="turn",
        attachment=[carrier, _skill_attachment(eid)],
    )
    assert fm2.model_dump()["body_downloaded"] is True

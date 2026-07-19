"""FlowpadDiagnosis bundle roundtrip: pack → wipe the local row → unpack
re-materializes the metadata-only entity from its packed ``header.json`` (same
create-or-fill-merge contract as task / claude_session). A diagnosis has no
backing source file, so the header IS the record. Real test DB, no mocks."""

from __future__ import annotations

import json
import zipfile

import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import (
    _pack_flowpad_diagnosis_attachment,
    pack_bundle,
    unpack_bundle,
)
from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FM_ID = "f5f5f5f5-0000-4000-8000-0000000000d1"


def _make_diagnosis() -> FlowpadDiagnosis:
    return FlowpadDiagnosis(
        name="Stuck download button",
        title="Stuck download button",
        symptoms="Chip stays on the 404 placeholder; Download never clears.",
        rca="Forwarded diagnosis entity was never packed into the bundle.",
        fix="Pack the diagnosis header.json and re-materialize on unpack.",
        summary="Diagnosis entity now travels in the bundle and re-materializes.",
        user_report="the forwarded report just shows a broken chip",
    )


async def test_pack_unpack_diagnosis_roundtrip(tmp_path):
    diag = _make_diagnosis()
    await diag.save(notify=False)

    fm = FlowMessage(
        text=f"Diagnosis: {diag.title}",
        sender_name="Alice",
        attachment=[
            Attachment(
                attachment_type=AttachmentType.TYPE_ID,
                data=f"{EntityType.FLOWPAD_DIAGNOSIS.value}-{diag.id}",
            )
        ],
    )
    fm.id = FM_ID

    zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path) as zf:
        header_name = f"attachment/{EntityType.FLOWPAD_DIAGNOSIS.value}-{diag.id}/header.json"
        assert header_name in zf.namelist()
        header = json.loads(zf.read(header_name))
        assert header["id"] == diag.id
        assert header["title"] == "Stuck download button"
        assert header["rca"].startswith("Forwarded diagnosis entity")

    # Simulate a clean receiver: wipe the local row.
    await diag.delete()
    assert await FlowpadDiagnosis.get_one({"id": diag.id}) is None

    await unpack_bundle(zip_path, local_user_id="receiver")

    restored = await FlowpadDiagnosis.get_one({"id": diag.id})
    assert restored is not None
    assert restored.title == "Stuck download button"
    assert restored.symptoms.startswith("Chip stays on the 404")
    assert restored.fix.startswith("Pack the diagnosis header.json")
    assert restored.summary.startswith("Diagnosis entity now travels")
    assert restored.user_report == "the forwarded report just shows a broken chip"

    await restored.delete()


async def test_pack_diagnosis_header_is_exact_whitelist(tmp_path):
    """[PACK-DIAGNOSIS] header.json carries EXACTLY the whitelisted keys, and a
    missing diagnosis id is a pure no-op (no entry written)."""
    diag = _make_diagnosis()
    await diag.save(notify=False)

    attachment_dir = tmp_path / "attachment"
    attachment_dir.mkdir(parents=True, exist_ok=True)
    await _pack_flowpad_diagnosis_attachment(diag.id, attachment_dir)

    header_path = (
        attachment_dir
        / f"{EntityType.FLOWPAD_DIAGNOSIS.value}-{diag.id}"
        / "header.json"
    )
    assert header_path.exists()
    header = json.loads(header_path.read_text(encoding="utf-8"))

    expected_keys = {
        "id", "type", "name", "title", "symptoms", "rca", "fix", "summary", "user_report",
    }
    assert set(header.keys()) == expected_keys
    assert header["type"] == EntityType.FLOWPAD_DIAGNOSIS.value

    # diagnosis-missing (get_one None) → no entry, pure no-op.
    missing_dir = tmp_path / "missing"
    missing_dir.mkdir(parents=True, exist_ok=True)
    missing_id = "f5f5f5f5-0000-4000-8000-0000000009d1"
    assert await FlowpadDiagnosis.get_one({"id": missing_id}) is None
    await _pack_flowpad_diagnosis_attachment(missing_id, missing_dir)
    assert list(missing_dir.iterdir()) == []

    await diag.delete()

"""A message's attachment bytes outlive the OS temp directory.

The OS event is real: the process temp dir points at a scratch dir (the machine's
own is never touched) and is emptied the way macOS does at boot. Messages from
before the fix are carried over by the 0.2.175 migration.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import _rewrite_file_attachments
from flow_sdk.fs_store.operations import flow_message as fm_data_ops
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.migrations.migration_2026_09_embedded_storage_to_record_data import migrate

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval

PNG = b"\x89PNG\r\n\x1a\nscreenshot-bytes"
NAME = "Screenshot 1.png"


@pytest.fixture()
def os_temp(tmp_path, monkeypatch):
    """The process's OS temp dir, relocated to a scratch dir we may empty."""
    temp = tmp_path / "os-temp"
    temp.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(temp))
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    reset_instance_settings()
    get_instance_settings()
    yield temp
    reset_instance_settings()


def _purge(temp: Path) -> None:
    """What macOS does to ``/var/folders/.../T`` at boot."""
    shutil.rmtree(temp)
    temp.mkdir()


def _file_state(fm: FlowMessage) -> tuple[bool, dict]:
    dumped = fm.model_dump()
    files = [a for a in dumped["attachment"] if a["attachment_type"] == AttachmentType.FILE.value]
    return all(a["local_path"] for a in files), dumped


def _msg(fm_id: str) -> FlowMessage:
    return FlowMessage(id=fm_id, text="see screenshot", attachment=[Attachment(attachment_type=AttachmentType.FILE, data=f"data/{NAME}")])


class _Upload:
    """The multipart part the add_message route hands to the sender seam."""

    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self._content = content

    async def read(self) -> bytes:
        return self._content


@pytest.mark.asyncio
async def test_sent_attachment_survives_an_os_temp_purge(os_temp):
    from flow_sdk.app.actions.notification_action import _attach_uploaded_files

    fm = FlowMessage(id=mint_uuid(), text="see screenshot")
    await _attach_uploaded_files(fm, [_Upload(NAME, PNG)])

    _purge(os_temp)

    present, dumped = _file_state(fm)
    assert present, f"sender lost its own attachment to an OS temp purge: {dumped['attachment']}"


def test_received_attachment_survives_an_os_temp_purge(os_temp, tmp_path):
    fm_id = mint_uuid()
    bundle = tmp_path / "bundle"
    (bundle / "attachment" / "files").mkdir(parents=True)
    (bundle / "attachment" / "files" / NAME).write_bytes(PNG)
    fm_data = {"attachment": [{"attachment_type": AttachmentType.FILE.value, "data": f"attachment/files/{NAME}"}]}

    _rewrite_file_attachments(fm_data, bundle, fm_id)
    fm = FlowMessage(id=fm_id, text="see screenshot", attachment=[Attachment(**a) for a in fm_data["attachment"]])

    _purge(os_temp)

    present, dumped = _file_state(fm)
    assert present, f"receiver lost the attachment to an OS temp purge: {dumped['attachment']}"
    assert Path(dumped["attachment"][0]["local_path"]).read_bytes() == PNG


def _db_with(tmp_path: Path, *fms: FlowMessage) -> Path:
    """The instance's entities table, as the migration reads it."""
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, data TEXT)")
    conn.executemany(
        "INSERT INTO entities (id, type, data) VALUES (?, 'flow_message', ?)",
        [(fm.id, json.dumps({"attachment": [a.model_dump(mode="json") for a in fm.attachment]})) for fm in fms],
    )
    conn.commit()
    conn.close()
    return db


def test_migration_restores_bytes_lost_after_unpack_from_the_bundle(os_temp, tmp_path):
    """The prod state: bundle unpacked, bytes purged — restored from the message's own copy."""
    fm = _msg(mint_uuid())
    root = fm_data_ops.unpacked_dir(fm.id)
    (root / "attachment" / "files").mkdir(parents=True)
    (root / "flow_message.json").write_text(json.dumps({"id": fm.id}))
    (root / "attachment" / "files" / NAME).write_bytes(PNG)

    counts = migrate(_db_with(tmp_path, fm), dry_run=False)

    present, dumped = _file_state(fm)
    assert present and counts["restored"] == 1, (counts, dumped["attachment"])
    assert Path(dumped["attachment"][0]["local_path"]).read_bytes() == PNG


def test_migration_carries_bytes_still_under_the_old_temp_root(os_temp, tmp_path):
    """A sender's upload from before the fix, not yet purged: no bundle to restore
    from, so the old temp copy is carried over before the next reboot eats it."""
    fm = _msg(mint_uuid())
    old = os_temp / "flow-embedded-storage" / "flow_message" / fm.id / "data" / NAME
    old.parent.mkdir(parents=True)
    old.write_bytes(PNG)
    db = _db_with(tmp_path, fm)

    assert migrate(db)["restored"] == 1 and not _file_state(fm)[0], "dry-run must not write"
    migrate(db, dry_run=False)
    _purge(os_temp)

    assert _file_state(fm)[0], "the carried-over copy must not live under the OS temp dir"
    assert migrate(db, dry_run=False) == {"files": 1, "present": 1, "restored": 0, "unrecoverable": 0}


def test_migration_counts_bytes_with_no_surviving_copy(os_temp, tmp_path):
    counts = migrate(_db_with(tmp_path, _msg(mint_uuid())), dry_run=False)
    assert counts == {"files": 1, "present": 0, "restored": 0, "unrecoverable": 1}

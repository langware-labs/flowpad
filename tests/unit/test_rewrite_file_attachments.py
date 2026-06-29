"""Receiver-side binary-attachment rewrite.

``_rewrite_file_attachments`` copies the FILE / PROMPT-with-file blobs that rode
inside a .flowmsg zip (all parked under ``attachment/files/<name>``) into the
receiver's per-FlowMessage embedded storage and re-splits them back into the
sender's VFS layout: FILE → ``data/<name>``, PROMPT-with-file → ``prompt/<name>``.
Inline-text PROMPTs and non-binary (URL / TYPE_ID) attachments carry no
``attachment/files/`` path, so they pass through untouched; a FILE whose bundle
source went missing is a no-op (left as-is, no crash).

No mocks: the real embedded-storage driver writes the bytes to a real temp dir;
we read them straight back through the same ``get_entity_embedded_storage`` the
production code uses.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.flow_message import (
    FILE_VFS_PREFIX,
    PROMPT_FILE_VFS_PREFIX,
    AttachmentType,
)
from flow_sdk.builtin.flow_message_bundle import _rewrite_file_attachments
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.storage import get_entity_embedded_storage

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture()
def isolated_instance(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    reset_instance_settings()
    yield get_instance_settings()
    reset_instance_settings()


def test_rewrite_file_attachments_resplits_and_copies_into_embedded_storage(
    isolated_instance, tmp_path
):
    fm_id = mint_uuid()  # UUID v4 entity id

    # The packer drops every binary blob (FILE or PROMPT-with-file) into the
    # zip's single ``attachment/files/`` dir; lay that out on disk.
    files_dir = tmp_path / "attachment" / "files"
    files_dir.mkdir(parents=True)
    file_bytes = b"\x00\x01FILE-attachment-bytes\xff"
    (files_dir / "report.bin").write_bytes(file_bytes)
    prompt_bytes = b"PROMPT-with-file-bytes\x00"
    (files_dir / "snippet.txt").write_bytes(prompt_bytes)
    # NOTE: no "missing.bin" written — branch (5) source is absent on purpose.

    inline_prompt_text = "do the thing, please"           # branch (3)
    passthrough_type_id = f"task-{mint_uuid()}"            # branch (4)

    fm_data = {
        "attachment": [
            # (1) FILE backed by a real blob → data/<name>
            {"attachment_type": AttachmentType.FILE.value,
             "data": "attachment/files/report.bin"},
            # (2) PROMPT backed by a real blob → prompt/<name>
            {"attachment_type": AttachmentType.PROMPT.value,
             "data": "attachment/files/snippet.txt"},
            # (3) inline-text PROMPT (no attachment/files/ path) → unchanged
            {"attachment_type": AttachmentType.PROMPT.value,
             "data": inline_prompt_text},
            # (4) non-FILE/PROMPT (TYPE_ID) → unchanged
            {"attachment_type": AttachmentType.TYPE_ID.value,
             "data": passthrough_type_id},
            # (5) FILE whose bundle source is missing → no-op, left as-is
            {"attachment_type": AttachmentType.FILE.value,
             "data": "attachment/files/missing.bin"},
        ]
    }

    _rewrite_file_attachments(fm_data, tmp_path, fm_id)

    atts = fm_data["attachment"]

    # Same embedded-storage driver the production code wrote through.
    storage = get_entity_embedded_storage(TypeId(type="flow_message", id=fm_id))
    file_prefix = FILE_VFS_PREFIX.rstrip("/")      # "data"
    prompt_prefix = PROMPT_FILE_VFS_PREFIX.rstrip("/")  # "prompt"

    # (1) FILE → data/report.bin, bytes copied verbatim into embedded storage.
    assert atts[0]["data"] == f"{file_prefix}/report.bin"
    from pathlib import Path
    dest_file = Path(storage.get_storage_path(atts[0]["data"]))
    assert dest_file.exists(), "FILE blob not copied into embedded storage"
    assert dest_file.read_bytes() == file_bytes

    # (2) PROMPT-with-file → prompt/snippet.txt, bytes copied verbatim.
    assert atts[1]["data"] == f"{prompt_prefix}/snippet.txt"
    dest_prompt = Path(storage.get_storage_path(atts[1]["data"]))
    assert dest_prompt.exists(), "PROMPT blob not copied into embedded storage"
    assert dest_prompt.read_bytes() == prompt_bytes

    # (3) inline-text PROMPT — passed through unchanged (no rewrite, no copy).
    assert atts[2]["data"] == inline_prompt_text

    # (4) TYPE_ID attachment — skipped/unchanged.
    assert atts[3]["data"] == passthrough_type_id

    # (5) FILE with a missing source — left exactly as-is, nothing written.
    assert atts[4]["data"] == "attachment/files/missing.bin"
    assert not Path(storage.get_storage_path(f"{file_prefix}/missing.bin")).exists()

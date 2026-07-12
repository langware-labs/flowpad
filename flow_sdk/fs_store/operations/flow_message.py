"""FlowMessage local-data operations — staging area for received bundles.

Layout (all under the message's dedicated record-data directory)::

    <records_data_root>/flow_message/flow_message-@<id>/
        download/body.flowmsg     raw bundle as fetched from the hub
        unpacked/                 extracted bundle tree (header.json, attachment/, metadata/, ...)

The ``unpacked/`` tree is the *staging* area: received file-backed assets live
here — viewable through the MessageAttachment read actions — until the user
explicitly installs them into a project or the user scope. Nothing under
``records_data`` is walked by the indexer, so staged content never becomes an
entity by itself.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from flow_sdk.fs_store.fs_record import record_stem

FLOW_MESSAGE_TYPE = "flow_message"
DOWNLOAD_SUBDIR = "download"
UNPACKED_SUBDIR = "unpacked"


def default_data_dir(record_id: str) -> Path:
    if not record_id:
        raise ValueError("record_id is required")
    from flow_sdk.fs_store.record_paths import get_default_records_data_root
    return (
        get_default_records_data_root()
        / FLOW_MESSAGE_TYPE
        / record_stem(FLOW_MESSAGE_TYPE, record_id)
    )


def download_dir(record_id: str) -> Path:
    return default_data_dir(record_id) / DOWNLOAD_SUBDIR


def unpacked_dir(record_id: str) -> Path:
    return default_data_dir(record_id) / UNPACKED_SUBDIR


def staged_entry_rel_path(entry_key: str) -> str:
    """Relative (to the FM data dir) staging path of one bundle attachment
    entry — the value persisted on ``MessageAttachment.unpacked_path``. Single
    owner of the ``unpacked/attachment/<key>`` layout string."""
    return f"{UNPACKED_SUBDIR}/attachment/{entry_key}"


def staged_entry_dir(record_id: str, entry_key: str) -> Path:
    """Staging dir of one bundle attachment entry (``<type>-@<id>`` key)."""
    return default_data_dir(record_id) / staged_entry_rel_path(entry_key)


def is_downloaded(record_id: str) -> bool:
    from flow_sdk.builtin.flow_message import BODY_FILENAME
    return (download_dir(record_id) / BODY_FILENAME).is_file()


def is_unpacked(record_id: str) -> bool:
    return (unpacked_dir(record_id) / "header.json").is_file()


async def purge_flow_message_local_data(record_id: str) -> None:
    """Remove the message's staging data and its MessageAttachment rows.

    Installed copies are the user's assets and are NOT touched.
    """
    if not record_id:
        return
    shutil.rmtree(default_data_dir(record_id), ignore_errors=True)
    from flow_sdk.builtin.message_attachment import MessageAttachment
    for ma in await MessageAttachment.get_all({"flow_message_id": record_id}):
        try:
            await ma.delete()
        except Exception:  # noqa: BLE001 — cleanup must not abort deletion
            pass

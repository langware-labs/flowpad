"""Provider drivers — the only modules allowed to know a provider's shape.

Importing this package registers every shipped driver. Nothing outside
``drivers/`` may read a provider-private key out of a cursor's ``state``;
``test_cursor_state_is_opaque_to_the_subsystem`` enforces that by grep.
"""

import os
from pathlib import Path

from flow_sdk.ingest.driver import register_driver
from flow_sdk.ingest.drivers.agent import AgentDriver
from flow_sdk.ingest.drivers.agentmail import AgentMailDriver
from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver
from flow_sdk.ingest.drivers.gcs import GoogleCloudStorageDriver
from flow_sdk.ingest.drivers.gdrive import GoogleDriveDriver
from flow_sdk.ingest.drivers.git import GitDriver
from flow_sdk.ingest.drivers.gmail import GmailDriver
from flow_sdk.ingest.drivers.hackernews import HackerNewsDriver
from flow_sdk.ingest.drivers.helpdesk import HelpdeskDriver
from flow_sdk.ingest.drivers.rss import RssDriver
from flow_sdk.ingest.drivers.slack import SlackDriver
from flow_sdk.ingest.drivers.teams import TeamsDriver
from flow_sdk.ingest.drivers.telegram import TelegramDriver
from flow_sdk.ingest.drivers.whatsapp import WhatsAppDriver
from flow_sdk.ingest.source_driver import SourceDriver
from flow_sdk.sources.providers.folder import WatchedFolderSource


def _folder_origin(row):
    """The watched directory, as the origin every ref is relative to."""
    from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415

    raw = (row.config or {}).get("root") or ""
    return local_origin_for_path(Path(raw).expanduser().resolve()) if raw else None


def _folder_origin_id(row, ref: str) -> str:
    """The filesystem's own handle for the file at ``ref``: its inode.

    It survives a rename within the volume, which a path cannot. Re-read after every index
    pass, because stamping a capsule rewrites the file atomically and moves the inode; an
    editor that saves atomically is honestly a new file. Meaningless off its volume, so it is
    scoped to the source and never shared.
    """
    st = Path(ref).stat()  # OSError → reflection falls back to the path
    return f"folder:{row.id}:ino:{st.st_dev}:{st.st_ino}"


register_driver(RssDriver())
register_driver(HackerNewsDriver())
register_driver(HelpdeskDriver())
register_driver(AgentDriver())
register_driver(AgentMailDriver())
register_driver(CloudEmailDriver())
register_driver(
    SourceDriver(
        WatchedFolderSource,
        kind="datasource.fs.folder",
        ref_for=lambda source, key: os.path.join(source.root, key),
        origin_for=_folder_origin,
        origin_id_for=_folder_origin_id,
    )
)
register_driver(GoogleDriveDriver())
register_driver(GoogleCloudStorageDriver())
register_driver(GitDriver())
register_driver(GmailDriver())
register_driver(SlackDriver())
register_driver(TeamsDriver())
register_driver(TelegramDriver())
register_driver(WhatsAppDriver())

__all__ = [
    "AgentDriver",
    "AgentMailDriver",
    "CloudEmailDriver",
    "GitDriver",
    "GmailDriver",
    "GoogleDriveDriver",
    "HackerNewsDriver",
    "HelpdeskDriver",
    "RssDriver",
    "SlackDriver",
    "TeamsDriver",
    "TelegramDriver",
    "WhatsAppDriver",
]

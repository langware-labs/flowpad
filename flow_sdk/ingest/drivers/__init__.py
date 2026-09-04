"""Provider drivers — the only modules allowed to know a provider's shape.

Importing this package registers every shipped driver. Nothing outside
``drivers/`` may read a provider-private key out of a cursor's ``state``;
``test_cursor_state_is_opaque_to_the_subsystem`` enforces that by grep.
"""

from flow_sdk.ingest.driver import register_driver
from flow_sdk.ingest.drivers.agent import AgentDriver
from flow_sdk.ingest.drivers.agentmail import AgentMailDriver
from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver
from flow_sdk.ingest.drivers.folder import FolderDriver
from flow_sdk.ingest.drivers.gcs import GoogleCloudStorageDriver
from flow_sdk.ingest.drivers.gdrive import GoogleDriveDriver
from flow_sdk.ingest.drivers.git import GitDriver
from flow_sdk.ingest.drivers.gmail import GmailDriver
from flow_sdk.ingest.drivers.hackernews import HackerNewsDriver
from flow_sdk.ingest.drivers.rss import RssDriver
from flow_sdk.ingest.drivers.slack import SlackDriver
from flow_sdk.ingest.drivers.teams import TeamsDriver
from flow_sdk.ingest.drivers.telegram import TelegramDriver
from flow_sdk.ingest.drivers.whatsapp import WhatsAppDriver

register_driver(RssDriver())
register_driver(HackerNewsDriver())
register_driver(AgentDriver())
register_driver(AgentMailDriver())
register_driver(CloudEmailDriver())
register_driver(FolderDriver())
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
    "FolderDriver",
    "GitDriver",
    "GmailDriver",
    "GoogleDriveDriver",
    "HackerNewsDriver",
    "RssDriver",
    "SlackDriver",
    "TeamsDriver",
    "TelegramDriver",
    "WhatsAppDriver",
]

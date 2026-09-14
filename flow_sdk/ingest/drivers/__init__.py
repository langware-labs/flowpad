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
from flow_sdk.ingest.drivers.helpdesk import HelpdeskDriver
from flow_sdk.ingest.source_driver import SourceDriver
from flow_sdk.sources.providers.folder import WatchedFolderSource
from flow_sdk.sources.providers.hackernews import HackerNewsSource
from flow_sdk.sources.providers.rss import RssSource
from flow_sdk.sources.providers.slack import SlackSource
from flow_sdk.sources.providers.teams import TeamsSource
from flow_sdk.sources.providers.telegram import TelegramSource
from flow_sdk.sources.providers.whatsapp import WhatsAppSource


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



def _connection_token(provider: str):
    """A resolver for this machine's connection to ``provider`` — its APP token first, when the
    provider issues one (Slack's bot), else the user's.

    The app is who a message source should be: it posts as whoever the token is, and an inbound
    message from the human reads as a stranger's — the thing that makes a reply addressable —
    only when we are NOT that human. The user token is the fallback, so an instance connected
    before the app half existed keeps working, degraded rather than broken.
    """

    async def resolve(row):
        from pydantic import SecretStr  # noqa: PLC0415

        from flow_sdk.core.oauth.provider_registry import app_credentials_name, token_for  # noqa: PLC0415
        from flow_sdk.sources.credentials import AuthShape, Credentials  # noqa: PLC0415

        app = app_credentials_name(provider)
        token = (await token_for(provider, name=app) if app else None) or await token_for(provider)
        return Credentials(shape=AuthShape.CONNECTOR, token=SecretStr(token)) if token else Credentials()

    return resolve


def _slack_outgoing(source, *, thread_key, to, text, subject="", in_reply_to=""):
    """The legacy send arguments as a Slack message: ``to`` is the channel (a Slack thread key
    is a bare ``ts`` and names none), and the thread it lands in is ``thread_key``. A subject has
    no Slack equivalent."""
    from flow_sdk.sources.values.items import MessageData  # noqa: PLC0415

    channel = str(to or "").strip()
    if not channel:
        raise ValueError("a slack send needs the channel id in `to`")
    if not (text or "").strip():
        raise ValueError("a slack send needs text")
    thread = str(thread_key or "").strip() or str(in_reply_to or "").strip()
    return MessageData(text=text, conversation=source.origin(thread, channel) if thread else source.channel_origin(channel)), None


def _slack_outbound_spec(_source):
    from flow_sdk.builtin.source_item import SlackMessageSpec  # noqa: PLC0415

    return SlackMessageSpec



def _config_secret(name: str):
    """A resolver that reads one secret from the row's config — until per-row secrets move out
    of config. Either way it reaches the source as a credential, never as configuration."""

    async def resolve(row):
        from pydantic import SecretStr  # noqa: PLC0415

        from flow_sdk.sources.credentials import AuthShape, Credentials  # noqa: PLC0415

        value = str((row.config or {}).get(name) or "").strip()
        return Credentials(shape=AuthShape.SECRETS, values={name: SecretStr(value)}) if value else Credentials()

    return resolve


def _telegram_outgoing(source, *, thread_key, to, text, subject="", in_reply_to=""):
    """``to`` is the chat — a chat reply targets the chat, never its author — and a forum topic
    rides ``thread_key``. ``in_reply_to`` (``<chat_id>/<message_id>``) makes it a reply to that
    message, which Telegram keeps in the replied message's topic. A subject has no equivalent."""
    from flow_sdk.sources.values.items import MessageData  # noqa: PLC0415

    chat = str(to or "").strip() or str(thread_key or "").split("/", 1)[0].strip()
    if not chat:
        raise ValueError("a telegram send needs a chat id in `to` or `thread_key`")
    answered = str(in_reply_to or "").strip()
    if "/" in answered and answered.rsplit("/", 1)[-1].isdigit():
        return MessageData(text=text), source.origin(answered)
    topic = str(thread_key or "").split("/", 1)[1:]
    return MessageData(text=text, conversation=source.chat_origin(chat, topic[0] if topic and topic[0].isdigit() else "")), None


def _telegram_outbound_spec(_source):
    from flow_sdk.builtin.source_item import TelegramMessageSpec  # noqa: PLC0415

    return TelegramMessageSpec



def _whatsapp_outgoing(source, *, thread_key, to, text, subject="", in_reply_to=""):
    """``to`` is the person's wa_id — the person IS the conversation — and ``in_reply_to`` quotes
    their message, which renders as a quote and starts no thread. A subject has no equivalent."""
    from flow_sdk.sources.providers.whatsapp import digits  # noqa: PLC0415
    from flow_sdk.sources.values.items import MessageData  # noqa: PLC0415

    wa_id = digits(to) or digits(thread_key)
    if not wa_id:
        raise ValueError("a whatsapp send needs the recipient's wa_id in `to`")
    quoted = str(in_reply_to or "").strip()
    if quoted:
        return MessageData(text=text), source.message_origin(quoted, wa_id)
    return MessageData(text=text, conversation=source.conversation_origin(wa_id)), None


def _whatsapp_outbound_spec(_source):
    from flow_sdk.builtin.source_item import WhatsAppMessageSpec  # noqa: PLC0415

    return WhatsAppMessageSpec



def _teams_outgoing(source, *, thread_key, to, text, subject="", in_reply_to=""):
    """``to`` is the composite ``{teamId}/{channelId}`` (a Teams thread key is a bare message id
    and names no channel); ``thread_key`` is the ROOT the post goes under. Without one it is a new
    root, and only then does ``subject`` mean anything. Graph posts as the connected user."""
    from flow_sdk.sources.providers.teams import TeamsMessageData, split_segment  # noqa: PLC0415

    segment = str(to or "").strip()
    if not all(split_segment(segment)):
        raise ValueError("a teams send needs `{teamId}/{channelId}` in `to`")
    if not (text or "").strip():
        raise ValueError("a teams send needs text")
    root = str(thread_key or "").strip() or str(in_reply_to or "").strip()
    conversation = source.origin(root, segment) if root else source.channel_origin(segment)
    return TeamsMessageData(text=text, subject=None if root else (subject or None), conversation=conversation), None


def _teams_outbound_spec(_source):
    from flow_sdk.builtin.source_item import TeamsMessageSpec  # noqa: PLC0415

    return TeamsMessageSpec


register_driver(SourceDriver(RssSource, kind="datasource.feed.rss"))
register_driver(SourceDriver(HackerNewsSource, kind="datasource.api.hackernews"))
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
register_driver(
    SourceDriver(
        SlackSource,
        kind="datasource.api.slack",
        credentials=_connection_token("slack"),
        outgoing=_slack_outgoing,
        outbound_spec=_slack_outbound_spec,
        lift_cursor=lambda state: SlackSource.resume_after(state["last_ts"]) if state.get("last_ts") else None,
    )
)
register_driver(
    SourceDriver(
        TeamsSource,
        kind="datasource.api.teams",
        credentials=_connection_token("microsoft"),
        outgoing=_teams_outgoing,
        outbound_spec=_teams_outbound_spec,
        lift_cursor=lambda state: TeamsSource.resume_after(state["last_created"]) if state.get("last_created") else None,
    )
)
register_driver(
    SourceDriver(
        TelegramSource,
        kind="datasource.api.telegram",
        credentials=_config_secret("bot_token"),
        outgoing=_telegram_outgoing,
        outbound_spec=_telegram_outbound_spec,
        lift_cursor=lambda state: TelegramSource.resume_at(state["next_offset"]) if state.get("next_offset") else None,
    )
)
register_driver(
    SourceDriver(
        WhatsAppSource,
        kind="datasource.api.whatsapp",
        credentials=_config_secret("access_token"),
        outgoing=_whatsapp_outgoing,
        outbound_spec=_whatsapp_outbound_spec,
    )
)

__all__ = [
    "AgentDriver",
    "AgentMailDriver",
    "CloudEmailDriver",
    "GitDriver",
    "GmailDriver",
    "GoogleDriveDriver",
    "HelpdeskDriver",
]

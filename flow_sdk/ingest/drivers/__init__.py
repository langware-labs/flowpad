"""Provider drivers — the only modules allowed to know a provider's shape.

Importing this package registers every shipped driver. Nothing outside
``drivers/`` may read a provider-private key out of a cursor's ``state``;
``test_cursor_state_is_opaque_to_the_subsystem`` enforces that by grep.
"""

import os
from pathlib import Path

from flow_sdk.ingest.driver import register_driver
from flow_sdk.ingest.drivers.agent import AgentDriver
from flow_sdk.ingest.drivers.gcs import GoogleCloudStorageDriver
from flow_sdk.ingest.drivers.gdrive import GoogleDriveDriver
from flow_sdk.ingest.drivers.git import GitDriver
from flow_sdk.ingest.drivers.gmail import GmailDriver
from flow_sdk.ingest.source_driver import SourceDriver
from flow_sdk.sources.providers.agentmail import SECRET_NAME as AGENTMAIL_SECRET
from flow_sdk.sources.providers.agentmail import AgentMailSource
from flow_sdk.sources.providers.cloud_email import CloudEmailSource
from flow_sdk.sources.providers.folder import WatchedFolderSource
from flow_sdk.sources.providers.hackernews import HackerNewsSource
from flow_sdk.sources.providers.helpdesk import HelpdeskSource
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



class AppHub:
    """The Flowpad hub as this process reaches it — the shared client's bearer, refresh and
    local-privacy gate — with its failures in the contract's words a person can act on."""

    async def get(self, entity_type, entity_id, action):
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        try:
            return await hub_get_or_raise(entity_type, entity_id, action)
        except HubError as exc:
            raise hub_refusal(exc, signed_in=bool(self.me())) from exc

    async def post(self, entity_type, payload, entity_id, action):
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415
        from flow_sdk.sources.errors import Rejected  # noqa: PLC0415

        try:
            answer = await hub_post(entity_type, payload, entity_id, action)
        except HubError as exc:
            raise hub_refusal(exc, signed_in=bool(self.me())) from exc
        if answer is None:
            raise Rejected("Flowpad Cloud is not configured on this instance.")
        return answer

    def me(self) -> str:
        """The logged-in hub user, or "" when signed out — the instance config's user pointer."""
        try:
            from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

            return str((get_user() or {}).get("id") or "")
        except Exception:  # noqa: BLE001
            return ""


def hub_refusal(exc, *, signed_in: bool):
    """A hub failure as the contract error that decides whether a desk keeps polling.

    The hub answers 401 "Forbidden access" to a caller with no role on the target, deliberately
    not distinguishing "no such desk" from "not a member" so existence does not leak: with a login
    in hand that is the membership answer, without one it is the login.
    """
    from flow_sdk.sources.errors import AccessDenied, NotFound, Rejected, SourceUnavailable  # noqa: PLC0415

    reason = str(getattr(exc, "reason", "") or "")
    status = int(getattr(exc, "status_code", 0) or 0)
    if status == 0:
        if "not configured" in reason:
            return Rejected(f"Flowpad Cloud is not configured on this instance ({reason}).")
        return SourceUnavailable(f"the hub could not be reached: {reason}")
    if status in (401, 403):
        return AccessDenied("You are not a member of this desk, or it does not exist." if signed_in else "Log in to Flowpad Cloud to read this desk.")
    if status == 404:
        return NotFound("This desk no longer exists on the hub.")
    if status == 429 or status >= 500:
        return SourceUnavailable(f"the hub answered {status}: {reason}")
    return Rejected(f"the hub refused the request ({status}): {reason}")


def _helpdesk_outgoing(source, *, thread_key, to, text, subject="", in_reply_to=""):
    """A reply goes to the TICKET — the hub conversation id — which the hub threads by."""
    from flow_sdk.sources.values.items import MessageData  # noqa: PLC0415

    ticket = str(to or "").strip() or str(thread_key or "").strip()
    if not ticket:
        raise ValueError("a help-desk reply needs the ticket's conversation id")
    return MessageData(text=text, conversation=source.ticket_origin(ticket)), None


def _helpdesk_outbound_spec(_source):
    from flow_sdk.builtin.source_item import HelpdeskMessageSpec  # noqa: PLC0415

    return HelpdeskMessageSpec


async def _helpdesk_choices(_row, field):
    """The desks this login can reach: the deployment's default desk and every desk adopted into a
    local project. Application state, not the hub's — so the application answers. Typing an id
    still works."""
    from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415
    from flow_sdk.builtin.helpdesk import Helpdesk  # noqa: PLC0415
    from flow_sdk.schema.data_spec.choice_spec import Choice  # noqa: PLC0415

    if field != "desk_project_id":
        return []
    out: list = []
    default = await resolve_helpdesk()
    if default is not None:
        out.append(Choice(id=default.project_id, name="Flowpad Support", detail="the deployment's default desk"))
    try:
        desks = await Helpdesk.get_all({})
    except Exception:  # noqa: BLE001 — no adopted desks is not a failure
        desks = []
    for desk in desks or []:
        queue = str(getattr(desk, "desk_project_id", "") or "").strip()
        if queue and all(c.id != queue for c in out):
            out.append(Choice(id=queue, name=str(getattr(desk, "display_name", "") or queue), detail="adopted desk"))
    return out



def _machine_secret(secret_name: str, *, config_key: str):
    """A resolver for a MACHINE secret (the SOD store, by name, with no project), falling back to
    the row's legacy ``config[config_key]`` so a source created before the move keeps working. The
    store wins when both exist."""

    async def resolve(row):
        from pydantic import SecretStr  # noqa: PLC0415

        from flow_sdk.sources.credentials import AuthShape, Credentials  # noqa: PLC0415

        value = ""
        try:
            from flow_sdk.cli.auth.secrets import read_secret  # noqa: PLC0415

            value = str(read_secret(secret_name) or "").strip()
        except Exception:  # noqa: BLE001 — a locked or absent store is "no key", not a crash
            value = ""
        value = value or str((row.config or {}).get(config_key) or "").strip()
        return Credentials(shape=AuthShape.SECRETS, values={config_key: SecretStr(value)}) if value else Credentials()

    return resolve


def _mail_outgoing(source, *, thread_key, to, text, subject="", in_reply_to=""):
    """A reply to a known message keeps the exchange one thread on the recipient's side; a bare send
    to ``to`` starts a new one, and only then does ``subject`` mean anything."""
    from flow_sdk.sources import UserProfile  # noqa: PLC0415
    from flow_sdk.sources.values.items import EmailMessageData  # noqa: PLC0415

    answered = str(in_reply_to or "").strip()
    if answered:
        return EmailMessageData(text=text), source.origin(answered)
    address = str(to or "").strip()
    if not address:
        raise ValueError(f"a {source.provider} send needs a recipient address in `to`")
    return EmailMessageData(text=text, subject=subject or None, recipients=(UserProfile(origin=source.origin(address), address=address),)), None



class AppMailbox:
    """An agent's hub mailbox as this process reaches it — the email-inbox driver family, the
    ordinary cloud login — with its failures as the contract errors that decide polling."""

    async def list_messages(self, agent_id, **filters):
        return await self._call("list_messages", agent_id, **filters)

    async def get_message(self, agent_id, message_id):
        return await self._call("get_message", agent_id, message_id)

    async def send(self, agent_id, body):
        return await self._call("send", agent_id, body)

    async def reply(self, agent_id, message_id, body):
        return await self._call("reply", agent_id, message_id, body)

    @staticmethod
    async def _call(verb, *args, **kwargs):
        from flow_sdk.builtin.email_inbox_driver import EmailInboxError, get_email_inbox_driver  # noqa: PLC0415

        try:
            return await getattr(get_email_inbox_driver(), verb)(*args, **kwargs) or {}
        except EmailInboxError as exc:
            raise mailbox_refusal(exc) from exc


def mailbox_refusal(exc):
    """A mailbox failure as the contract error. Two cases the status table cannot know: no status at
    all (a backend not configured needs a person; a transport failure needs the next tick), and a
    404, which on this route means the agent has no mailbox — re-provisioning is a human act."""
    from flow_sdk.sources import http  # noqa: PLC0415
    from flow_sdk.sources.errors import NotFound, Rejected, SourceUnavailable  # noqa: PLC0415

    reason = str(getattr(exc, "reason", "") or "")
    status = int(getattr(exc, "status_code", 0) or 0)
    if status == 0:
        if "not configured" in reason:
            return Rejected(f"The email inbox backend is not configured on this instance ({reason}).")
        return SourceUnavailable(f"the mailbox could not be reached: {reason}")
    if status == 404:
        return NotFound(reason or "This agent has no mailbox.")
    return http.error_for_status(status, reason)


def _cloud_email_config(row):
    """The agent a mailbox row serves: its config, else the Agent that owns it."""
    from flow_sdk.inbox.projection import agent_id_of  # noqa: PLC0415

    agent = agent_id_of(row)
    return {"agent_id": agent} if agent else {}


register_driver(SourceDriver(RssSource, kind="datasource.feed.rss"))
register_driver(SourceDriver(HackerNewsSource, kind="datasource.api.hackernews"))
register_driver(
    SourceDriver(
        HelpdeskSource,
        kind="datasource.hub.helpdesk",
        build=lambda binding: HelpdeskSource(binding, hub=AppHub()),
        outgoing=_helpdesk_outgoing,
        outbound_spec=_helpdesk_outbound_spec,
        choices=_helpdesk_choices,
        lift_cursor=lambda state: (
            HelpdeskSource.resume_at(state["high_water"], state.get("boundary_ids") or []) if state.get("high_water") else None
        ),
    )
)
register_driver(AgentDriver())
register_driver(
    SourceDriver(
        AgentMailSource,
        kind="datasource.api.agentmail",
        credentials=_machine_secret(AGENTMAIL_SECRET, config_key="api_key"),
        outgoing=_mail_outgoing,
        lift_cursor=lambda state: AgentMailSource.resume_after(state["high_water"]) if state.get("high_water") else None,
    )
)
register_driver(
    SourceDriver(
        CloudEmailSource,
        kind="datasource.cloud.email",
        build=lambda binding: CloudEmailSource(binding, mailbox=AppMailbox()),
        configure=_cloud_email_config,
        outgoing=_mail_outgoing,
        lift_cursor=lambda state: (
            CloudEmailSource.resume_at(state["high_water"], state.get("boundary_ids") or [])
            if state.get("high_water") and state.get("boundary_ids") else None
        ),
    )
)
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
    "GitDriver",
    "GmailDriver",
    "GoogleDriveDriver",
]

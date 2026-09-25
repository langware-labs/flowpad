"""``HttpChatSource`` — a deployment's HTTP chat as a message channel.

An OpenAI-style chat request posted to the deployment's ``chat`` ServiceEndpoint is pushed into
this channel (``events_from_request``): the last ``user`` message is one message, from the caller,
in a thread that is that caller's conversation. The deployment's agent loop answers it like any
other channel; the reply is recorded as our own message in the thread (``echoes_sends = False`` —
nothing leaves the machine), and the endpoint answers the HTTP request with it (``reply_payload``).

The caller is stamped onto the payload by the endpoint route, which authenticated it; so a thread
is scoped to its caller and the channel admits whoever the endpoint admitted (``open_inbound``).
Deliberately NOT ``events_from_webhook``: the public webhook route would take a caller from the
body, and anyone could speak as anyone.
"""
from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone
from typing import Any, Optional

from flow_sdk.builtin.source_item import MessageSpec
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin

CALLERS = "callers"


class HttpChatMessageSpec(MessageSpec):
    """A reply in a chat thread: to the caller who asked, answering their message."""

    @classmethod
    def reply_to(cls, m, *, body: str, attachments=()) -> "HttpChatMessageSpec":
        return cls(
            to=[str(getattr(m, "author_external_id", "") or "")],
            body=body,
            thread_key=str(getattr(m, "thread_key", "") or ""),
            reply_to_external_id=str(getattr(m, "external_id", "") or ""),
            attachments=list(attachments),
        )


class HttpChatConfig(SourceConfig):
    """Which deployment's chat endpoint this channel carries."""

    deployment_id: str


class HttpChatSource(MessageSource):

    Config = HttpChatConfig
    provider = "http_chat"
    identity_config_key = "deployment_id"
    #: The endpoint route authenticated the caller before the message got here.
    open_inbound = True
    #: Nothing is sent anywhere: the reply IS the recorded copy the HTTP response is read from.
    echoes_sends = False
    #: A chat is waiting on the other end — drain as fast as the loop will.
    attention_poll_seconds = 1

    @classmethod
    def outbound_spec(cls) -> type:
        return HttpChatMessageSpec

    # ── identities ──────────────────────────────────────────────────────────
    def thread(self, thread_key: str) -> CloudOrigin:
        return self.origin(thread_key, "threads")

    def _me(self) -> UserProfile:
        """Who the channel's own messages are from: the deployment (``deployment:<id>``, the row's
        account key and so its self-address)."""
        me = self.binding.account_key or f"deployment:{self.config.get('deployment_id') or ''}"
        return UserProfile(origin=CloudOrigin(kind=self.provider, namespace=CALLERS, key=me), name=self.binding.name or None)

    # ── inbound: the endpoint's request ─────────────────────────────────────
    def events_from_request(self, payload: Any) -> list[DataSourceEvent]:
        """``{messages, metadata: {conversation_id, message_id?}, caller}`` → the last user message,
        or nothing when the request has no user text. The route minted the conversation id."""
        body = payload if isinstance(payload, dict) else {}
        text = request_text(body)
        metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
        caller = str(body.get("caller") or "").strip()
        conversation_id = str(metadata.get("conversation_id") or "").strip()
        if not (text and caller and conversation_id):
            return []
        message_id = str(metadata.get("message_id") or "") or f"m-{secrets.token_hex(8)}"
        thread_key = thread_key_of(caller, conversation_id)
        origin = self.origin(message_id, "threads", thread_key)
        item = MessageItem(
            origin=origin,
            data=MessageData(
                text=text,
                conversation=self.thread(thread_key),
                sender=UserProfile(origin=CloudOrigin(kind=self.provider, namespace=CALLERS, key=caller), name=caller),
                sent_at=datetime.now(timezone.utc),
            ),
        )
        return [DataSourceEvent(id=message_id, kind=EventKind.UPSERT, origin=origin, item=item)]

    # ── outbound: the reply, recorded ───────────────────────────────────────
    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        if not thread_key:
            # Said to a caller without a conversation named: it starts one, theirs.
            if not str(to or "").strip():
                raise ValueError("a chat message needs the caller it is to, or the thread it continues")
            thread_key = thread_key_of(str(to).strip(), f"c-{secrets.token_hex(8)}")
        answered = self.origin(in_reply_to, "threads", thread_key) if in_reply_to else None
        return MessageData(text=text, conversation=self.thread(thread_key)), answered

    async def send(self, data: MessageData) -> MessageItem:
        return self._said(data, in_reply_to=None)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        thread_key = origin.namespace.rsplit("/", 1)[-1]
        return self._said(data.model_copy(update={"conversation": self.thread(thread_key)}), in_reply_to=origin)

    def _said(self, data: MessageData, *, in_reply_to: Optional[CloudOrigin]) -> MessageItem:
        thread_key = data.conversation.key if data.conversation is not None else ""
        origin = self.origin(f"r-{secrets.token_hex(8)}", "threads", thread_key)
        return MessageItem(origin=origin, data=MessageData(
            text=data.text, conversation=data.conversation, sender=self._me(),
            sent_at=datetime.now(timezone.utc), in_reply_to=in_reply_to,
        ))

    # ── the HTTP side: which thread a caller's conversation is, and the response ─
    @classmethod
    def request_thread(cls, caller: str, conversation_id: str) -> str:
        """The thread a caller's conversation is on this channel (``thread_key`` of its messages)."""
        return thread_key_of(caller, conversation_id)

    @classmethod
    def reply_payload(cls, request: Any, reply: Any, *, model: str) -> dict:
        """The OpenAI ``chat.completion`` answering *request* (the ingested row) with *reply*."""
        conversation_id = conversation_of(str(getattr(request, "thread_key", "") or ""))
        return {
            "id": f"chatcmpl-{getattr(request, 'external_id', '')}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": str(getattr(reply, "body", "") or "")},
                         "finish_reason": "stop"}],
            "flowpad": {"conversation_id": conversation_id},
        }


def request_text(body: dict) -> str:
    """The last ``user`` message's text — a string, or the text parts of a content list."""
    messages = body.get("messages") if isinstance(body.get("messages"), list) else []
    user = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), None)
    content = user.get("content") if user else None
    if isinstance(content, list):
        content = "\n".join(str(p.get("text") or "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return str(content or "").strip()


def thread_key_of(caller: str, conversation_id: str) -> str:
    """A thread is one caller's conversation — the same id from someone else is another thread."""
    return f"{caller}:{conversation_id}"


def conversation_of(thread_key: str) -> str:
    return thread_key.rpartition(":")[2]

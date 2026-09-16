"""Process-local prompt/reply message blocks.

``MessageBlock`` is the smallest conversational block: one listener receives
prompts and replies to them, while ``send`` waits for the matching reply.  It
does not ingest, persist, address, or deliver messages through a provider;
those jobs belong to ``DataSource`` and ``Inbox``.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import ClassVar

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.utils.kind_registry import KindRegistry


class _MessageRequestExpired(RuntimeError):
    """The sender stopped waiting after its request was delivered."""


class MessageRequest(DataSpec):
    """One prompt awaiting one reply from a ``MessageBlock`` listener.

    The source owns the lifecycle.  Callers receive this handle only while a
    listener is active and complete it exactly once with :meth:`reply`.
    ``body``, ``name``, ``thread_key`` and ``external_id`` also make it a valid
    input to ``Agent.process_message`` without coupling either block to the other.
    """

    text: str
    thread_key: str
    external_id: str

    @property
    def body(self) -> str:
        return self.text

    @property
    def name(self) -> str:
        return ""

    async def reply(self, text: str) -> None:
        """Complete this request with ``text``; a request can be replied once."""
        if not isinstance(text, str):
            raise TypeError("message reply must be a string")
        listener = _active_simple_listeners.get(self.thread_key)
        if listener is None:
            raise RuntimeError("message request is not bound to an active source")
        listener.resolve(self, text)


_active_simple_listeners: dict[str, "_SimpleListener"] = {}


class _SimpleListener:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[MessageRequest | None] = asyncio.Queue()
        self.pending: dict[str, asyncio.Future[str]] = {}
        self.closed = False

    def __aiter__(self) -> "_SimpleListener":
        return self

    async def __anext__(self) -> MessageRequest:
        while True:
            queued = await self.queue.get()
            if queued is None or self.closed:
                raise StopAsyncIteration
            request = queued
            if request.external_id in self.pending:
                return request

    def resolve(self, request: MessageRequest, text: str) -> None:
        future = self.pending.pop(request.external_id, None)
        if future is None:
            if self.closed:
                raise RuntimeError("message block listener is closed")
            raise _MessageRequestExpired("message request is no longer awaiting a reply")
        if future.done():
            raise _MessageRequestExpired("message request is no longer awaiting a reply")
        future.set_result(text)

    def close(self, error: Exception | None = None) -> None:
        if self.closed:
            return
        self.closed = True
        for future in self.pending.values():
            if not future.done():
                future.set_exception(error or RuntimeError("message block listener closed before replying"))
        self.pending.clear()
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(None)


class MessageBlock:
    """Factory and interface for conversational message blocks.

    ``MessageBlock.get("simple")`` returns a fresh process-local channel.
    """

    kind: ClassVar[str]
    _registry: ClassVar[KindRegistry[type["MessageBlock"]]] = KindRegistry("message block")

    @classmethod
    def get(cls, kind: str) -> "MessageBlock":
        """Create a fresh source of ``kind``."""
        try:
            source_type = cls._registry.get(kind)
        except KeyError as exc:
            raise ValueError(str(exc)) from exc
        return source_type()

    @contextlib.asynccontextmanager
    async def listen(self) -> AsyncIterator[AsyncIterator[MessageRequest]]:
        """Open the source's single listener."""
        raise NotImplementedError
        yield  # pragma: no cover

    async def send(self, prompt: str) -> str:
        """Send ``prompt`` and wait for its listener's reply."""
        raise NotImplementedError

    def _fail(self, error: Exception) -> None:
        """Fail pending sends when the responder can no longer consume them."""
        raise NotImplementedError


class _SimpleMessageBlock(MessageBlock):
    kind = "simple"

    def __init__(self) -> None:
        self.id = str(mint_uuid())
        self._listener: _SimpleListener | None = None

    @contextlib.asynccontextmanager
    async def listen(self) -> AsyncIterator[AsyncIterator[MessageRequest]]:
        if self._listener is not None:
            raise RuntimeError("message block already has an active listener")
        listener = _SimpleListener()
        self._listener = listener
        _active_simple_listeners[self.id] = listener
        try:
            yield listener
        finally:
            listener.close()
            if _active_simple_listeners.get(self.id) is listener:
                _active_simple_listeners.pop(self.id)
            if self._listener is listener:
                self._listener = None

    async def send(self, prompt: str) -> str:
        if not isinstance(prompt, str):
            raise TypeError("message prompt must be a string")
        if not prompt.strip():
            raise ValueError("message prompt cannot be blank")
        listener = self._listener
        if listener is None or listener.closed:
            raise RuntimeError("message block has no active listener")

        future = asyncio.get_running_loop().create_future()
        request = MessageRequest(text=prompt, thread_key=self.id, external_id=str(mint_uuid()))
        listener.pending[request.external_id] = future
        listener.queue.put_nowait(request)
        try:
            return await future
        except asyncio.CancelledError:
            listener.pending.pop(request.external_id, None)
            raise

    def _fail(self, error: Exception) -> None:
        listener = self._listener
        if listener is not None:
            listener.close(error)


MessageBlock._registry.register(_SimpleMessageBlock)


__all__ = ["MessageRequest", "MessageBlock"]

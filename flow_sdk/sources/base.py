"""``Source`` — the session every source is, and ``CollectionSource`` — the read path most
sources share.

A source is constructed from one ``SourceBinding`` and does no I/O until entered. Entering
prepares access; exiting releases it, closes what it opened, and never suppresses the body's
exception. One instance holds at most one active session; sequential reopening is fine.
Every source accepts notifications: one async ``on_change`` handler per session, delivered
through ``notify`` one at a time and awaited to completion.

Traits are ``ClassVar``s the runtime reads off the class; a source never branches on its own
name and the runtime never branches on a source's.
"""

from __future__ import annotations

import asyncio
import errno
import inspect
from abc import ABC, abstractmethod
from contextvars import ContextVar
from typing import Any, AsyncGenerator, Callable, ClassVar, Mapping, Optional, Sequence, TypeVar

from flow_sdk._compat import StrEnum
from flow_sdk.sources import _paging
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import Credentials
from flow_sdk.sources.errors import AccessDenied, NotFound, SourceError, SourceUnavailable, Unsupported
from flow_sdk.sources.values.event import ChangeHandler, DataSourceEvent
from flow_sdk.sources.values.items import SourceItemSpec
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, DataPage
from flow_sdk.sources.values.query import DataQuery

T = TypeVar("T")

_dispatching: ContextVar[Optional["Source"]] = ContextVar("flow_source_dispatching", default=None)


class Altitude(StrEnum):
    """Where a source's code runs. ``HOST`` — a subprocess the runtime spawns — is the default;
    ``IN_PROCESS`` is reserved for generic local sources that read this machine's own tree."""

    HOST = "host"
    IN_PROCESS = "in_process"


class Source:
    # ── traits ──────────────────────────────────────────────────────────────
    #: Registry key and manifest ``name``.
    provider: ClassVar[str] = ""
    #: The origin ``kind`` this source stamps; defaults to ``provider``.
    origin_kind: ClassVar[str] = ""
    altitude: ClassVar[Altitude] = Altitude.HOST
    page_size: ClassVar[int] = DEFAULT_PAGE_SIZE
    #: The source hands back a ``resume_cursor`` the application may persist across sessions.
    durable_cursor: ClassVar[bool] = False
    #: Strangers are the point of this channel (a help desk): an empty allowlist admits everyone.
    open_inbound: ClassVar[bool] = False
    #: The source's bytes are ours to write an identity into.
    stamps_identity: ClassVar[bool] = True
    #: Sub-tick poll cadence while someone is watching; ``None`` means the provider does not tolerate it.
    attention_poll_seconds: ClassVar[Optional[int]] = None
    #: Ceiling on segments synced per pass; ``None`` means the runtime's budget.
    segment_budget: ClassVar[Optional[int]] = None
    #: The config field naming WHICH remote account a row serves.
    identity_config_key: ClassVar[str] = "inbox"
    #: The machine-level connection this source reads with, when the credential is not in the row.
    connection: ClassVar[Optional[str]] = None
    #: The payload is files placed on disk (reflection), not records in the graph.
    reflects: ClassVar[bool] = False

    def __init__(self, binding: SourceBinding) -> None:
        if not isinstance(binding, SourceBinding):
            raise TypeError(f"expected SourceBinding, got {type(binding).__name__}")
        cls = type(self)
        self.binding = binding
        self._scope = Scope(cls.origin_kind_for(binding.config), cls.namespace_for(binding))
        self._session: Optional[object] = None
        self._handler: Optional[ChangeHandler] = None
        self._notify_lock: Optional[asyncio.Lock] = None

    # ── what a subclass says about a configuration ──────────────────────────
    @classmethod
    def origin_kind_for(cls, config: Mapping[str, Any]) -> str:
        return cls.origin_kind or cls.provider

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        """The per-row scope prefix of every origin this source produces: the account it reads
        as. A source whose resources live in segments joins the segment on per origin
        (``origin(key, segment)``); one with no account at all scopes by segment alone."""
        return binding.account_key

    @property
    def config(self) -> Mapping[str, Any]:
        return self.binding.config

    @property
    def credentials(self) -> Credentials:
        return self.binding.credentials

    @property
    def effective_page_size(self) -> int:
        return self.binding.page_size or type(self).page_size

    def origin(self, key: str, *within: str) -> CloudOrigin:
        """The identity of ``key`` within this source's scope, narrowed by ``within`` (a
        segment). No I/O."""
        return self._scope.origin(key, *within)

    # ── session ─────────────────────────────────────────────────────────────
    async def __aenter__(self) -> "Source":
        if self._session is not None:
            raise RuntimeError(f"{type(self).__name__} session is already active")
        self._session = object()
        self._notify_lock = asyncio.Lock()
        try:
            await self._open()
        except BaseException:
            await self.__aexit__(None, None, None)
            raise
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        self._session = None
        self._handler = None
        await self._close()

    async def _open(self) -> None:
        """Acquire session resources."""

    async def _close(self) -> None:
        """Release session resources, including anything still open."""

    def _require_open(self) -> object:
        if self._session is None:
            raise RuntimeError(f"{type(self).__name__} session is not active")
        return self._session

    # ── notifications ───────────────────────────────────────────────────────
    def on_change(self, handler: ChangeHandler) -> None:
        self._require_open()
        if not _is_async_callable(handler):
            raise TypeError("handler must be an async function")
        if self._handler is not None:
            raise RuntimeError("a change handler is already registered for this session")
        self._handler = handler

    async def notify(self, event: DataSourceEvent) -> None:
        if not isinstance(event, DataSourceEvent):
            raise TypeError(f"expected DataSourceEvent, got {type(event).__name__}")
        session = self._require_open()
        if _dispatching.get() is self:
            raise RuntimeError("a change handler cannot notify its own source; it would wait on itself")
        assert self._notify_lock is not None
        async with self._notify_lock:
            if self._session is not session:
                raise RuntimeError("the session ended before this notification was handled")
            if self._handler is None:
                raise RuntimeError("no change handler is registered")
            token = _dispatching.set(self)
            try:
                await self._handler(event)
            finally:
                _dispatching.reset(token)

    # ── blocking I/O ────────────────────────────────────────────────────────
    async def _blocking(
        self,
        fn: Callable[..., T],
        /,
        *args: object,
        origin: Optional[CloudOrigin] = None,
        undo: Optional[Callable[[T], object]] = None,
    ) -> T:
        """Run a blocking call in a worker thread and translate OS failures.

        A thread cannot be interrupted. On cancellation the call is allowed to finish, its
        result is handed to ``undo`` so nothing stays half-done, and only then does
        ``CancelledError`` propagate — a cancelled operation never changes anything after it
        raises.
        """
        future = asyncio.ensure_future(asyncio.to_thread(fn, *args))
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            await _settle(future, undo)
            raise
        except SourceError:
            raise
        except OSError as exc:
            translated = self._translate(exc, origin)
            if translated is exc:
                raise
            raise translated from exc

    def _translate(self, exc: OSError, origin: Optional[CloudOrigin]) -> Exception:
        """Map an OS failure to the family. A provider overrides for its own client's errors."""
        if isinstance(exc, IsADirectoryError):
            return exc
        if exc.errno == errno.ENAMETOOLONG:
            return ValueError(f"name is too long: {exc.filename}")
        if isinstance(exc, PermissionError):
            return AccessDenied(str(exc), origin=origin)
        if isinstance(exc, FileNotFoundError):
            return NotFound(str(exc), origin=origin)
        return SourceUnavailable(str(exc), origin=origin)


class CollectionSource(Source, ABC):
    """Implement ``_lookup``, ``_scan`` and ``_item``; ``get``, ``fetch`` and ``iterate`` follow."""

    supported_queries: ClassVar[tuple[type[DataQuery], ...]] = ()
    page_type: ClassVar[type[DataPage]] = DataPage

    async def get(self, origin: CloudOrigin) -> Optional[SourceItemSpec]:
        self._require_open()
        key = self._scope.key(origin)
        raw = await self._lookup(key)
        return None if raw is None else self._item(key, raw)

    async def fetch(
        self,
        query: Optional[DataQuery] = None,
        *,
        cursor: Optional[str] = None,
        page_size: Optional[int] = None,
    ) -> DataPage:
        self._require_open()
        self._check_query(query)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        token = _paging.query_token(query)
        after = None if cursor is None else _paging.decode(cursor, token)
        entries, last = _paging.slice_after(await self._scan(query), after, limit)
        return self.page_type(
            items=tuple(self._item(key, raw) for key, raw in entries),
            next_cursor=None if last is None else _paging.encode(last, token),
        )

    async def iterate(
        self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None
    ) -> AsyncGenerator[SourceItemSpec, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(query, cursor=cursor, page_size=page_size)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    def _check_query(self, query: object) -> None:
        if query is None:
            return
        if not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if not isinstance(query, self.supported_queries):
            raise Unsupported(f"{type(self).__name__} does not support {type(query).__name__}")

    @abstractmethod
    async def _lookup(self, key: str) -> Any:
        """The raw state at ``key``, or ``None`` when the source establishes absence."""

    @abstractmethod
    async def _scan(self, query: Optional[DataQuery]) -> Sequence[tuple[str, Any]]:
        """``(key, raw)`` pairs matching ``query``, sorted by key."""

    @abstractmethod
    def _item(self, key: str, raw: Any) -> SourceItemSpec:
        """The concrete item for one raw entry."""


class Scope:
    """Maps a source's keys to origins and back; refuses origins from another scope."""

    __slots__ = ("kind", "namespace")

    def __init__(self, kind: str, namespace: str) -> None:
        CloudOrigin(kind=kind, namespace="-", key="-")  # validate the kind eagerly
        self.kind = kind
        self.namespace = namespace

    def origin(self, key: str, *within: str) -> CloudOrigin:
        """``namespace`` joined with ``within`` — ``<account>/<segment>``, or whichever exists."""
        namespace = "/".join(part for part in (self.namespace, *within) if part)
        return CloudOrigin(kind=self.kind, namespace=namespace, key=key)

    def key(self, origin: object) -> str:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin.kind != self.kind or origin.namespace != self.namespace:
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin.key


def positive_int(value: object, name: str, maximum: Optional[int] = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be at most {maximum}")
    return value


def _is_async_callable(obj: object) -> bool:
    return inspect.iscoroutinefunction(obj) or (callable(obj) and inspect.iscoroutinefunction(obj.__call__))


async def _settle(future: "asyncio.Future[T]", undo: Optional[Callable[[T], object]]) -> None:
    """Wait for ``future`` despite further cancellation, then undo a successful result."""
    while not future.done():
        try:
            await asyncio.wait({future})
        except asyncio.CancelledError:
            continue
    if undo is not None and not future.cancelled() and future.exception() is None:
        undo(future.result())


__all__ = ["Altitude", "CollectionSource", "Scope", "Source", "positive_int"]

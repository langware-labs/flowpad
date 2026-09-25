"""The conformance kit: one suite that any source must pass, on any altitude.

A ``Subject`` says how to get a fresh source and what it contains; ``checks_for`` picks the
checks the source's capabilities make applicable (by ``issubclass`` against the protocols —
a check for a capability the source lacks is not skipped, it is not selected); each check
opens its own session, so nothing leaks between them. The same subject can wrap a class
in-process, a proxy over a host or a client over REST: the checks cannot tell, which is the
point.

Every check is a short, plain coroutine — the contract clause it pins is its name.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.base import Source
from flow_sdk.sources.errors import InvalidCursor, NotFound, Unsupported
from flow_sdk.sources.families import MessageSource, ObjectSource, RecordSource
from flow_sdk.sources.protocols import ByteStore, Drafting, Listable, Messaging, Mutable, Readable
from flow_sdk.sources.values import (
    CloudOrigin,
    DataSourceEvent,
    EventKind,
    FileData,
    FileItem,
    MessageData,
    MessageItem,
    RecordData,
    UserProfile,
)


@dataclass
class Subject:
    """How to obtain a fresh source and what it holds."""

    #: A NEW, unopened instance each call.
    source: Callable[[], Source]
    #: Populate a freshly opened session; ``None`` when the backing store is pre-populated.
    seed: Optional[Callable[[Source], Awaitable[None]]] = None
    #: Origins present after seeding — at least three for the listing checks.
    seeded: tuple[CloudOrigin, ...] = ()
    #: An existing conversation, for ``Messaging`` sources.
    conversation: Optional[CloudOrigin] = None
    #: Someone the source can address, for recipient-mode sending.
    recipient: Optional[UserProfile] = None
    #: A complete payload ``create`` accepts, for ``Mutable`` sources.
    create_data: Optional[DataSpec] = None
    #: A relative path ``write`` may use, for ``ByteStore`` sources.
    writable_path: str = "conformance/written.bin"

    async def opened(self) -> Source:
        s = self.source()
        await s.__aenter__()
        try:
            if self.seed is not None:
                await self.seed(s)
        except BaseException:
            await s.__aexit__(None, None, None)
            raise
        return s


@dataclass(frozen=True)
class Check:
    name: str
    requires: Optional[type]
    run: Callable[[Subject], Awaitable[None]]

    def __str__(self) -> str:
        return self.name


_CHECKS: list[Check] = []


def check(requires: Optional[type] = None):
    def register(fn: Callable[[Subject], Awaitable[None]]) -> Callable[[Subject], Awaitable[None]]:
        _CHECKS.append(Check(fn.__name__, requires, fn))
        return fn

    return register


def checks_for(source_cls: type) -> list[Check]:
    """The checks a source of this class must pass."""
    return [c for c in _CHECKS if c.requires is None or issubclass(source_cls, c.requires)]


async def run_all(subject: Subject) -> dict[str, Optional[BaseException]]:
    """Run every applicable check; ``None`` marks a pass. For the CLI and for hosts."""
    results: dict[str, Optional[BaseException]] = {}
    for c in checks_for(type(subject.source())):
        try:
            await c.run(subject)
            results[c.name] = None
        except BaseException as exc:  # noqa: BLE001 — a report, not a handler
            results[c.name] = exc
    return results


def _event(s: Source) -> DataSourceEvent:
    return DataSourceEvent(id="conformance-1", kind=EventKind.UPSERT, origin=s.origin("conformance"))


def _expect(exc_type: type[BaseException], coro_or_fn: Any) -> Any:
    async def run() -> None:
        try:
            result = coro_or_fn() if callable(coro_or_fn) else coro_or_fn
            if asyncio.iscoroutine(result):
                await result
        except exc_type:
            return
        raise AssertionError(f"expected {exc_type.__name__}")

    return run()


# ── every source: session and notifications ────────────────────────────────


@check()
async def an_operation_outside_a_session_is_a_runtime_error(subject: Subject) -> None:
    s = subject.source()
    await _expect(RuntimeError, s.notify(_event(s)))


@check()
async def entering_an_open_session_again_is_refused(subject: Subject) -> None:
    s = await subject.opened()
    try:
        await _expect(RuntimeError, s.__aenter__())
    finally:
        await s.__aexit__(None, None, None)


@check()
async def a_session_can_be_reopened_after_it_closed(subject: Subject) -> None:
    s = subject.source()
    async with s:
        pass
    async with s:
        pass


@check()
async def a_change_handler_must_be_async(subject: Subject) -> None:
    async with subject.source() as s:
        await _expect(TypeError, lambda: s.on_change(lambda event: None))  # type: ignore[arg-type]


@check()
async def one_handler_per_session(subject: Subject) -> None:
    async def handler(event: DataSourceEvent) -> None:
        pass

    async with subject.source() as s:
        s.on_change(handler)
        await _expect(RuntimeError, lambda: s.on_change(handler))


@check()
async def notify_without_a_handler_is_refused(subject: Subject) -> None:
    async with subject.source() as s:
        await _expect(RuntimeError, s.notify(_event(s)))


@check()
async def notify_awaits_the_handler_and_propagates_its_error(subject: Subject) -> None:
    seen: list[DataSourceEvent] = []

    async def handler(event: DataSourceEvent) -> None:
        seen.append(event)
        raise KeyError("handler failed")

    async with subject.source() as s:
        s.on_change(handler)
        event = _event(s)
        await _expect(KeyError, s.notify(event))
        assert seen == [event]


@check()
async def a_handler_cannot_notify_its_own_source(subject: Subject) -> None:
    async with subject.source() as s:

        async def handler(event: DataSourceEvent) -> None:
            await s.notify(event)

        s.on_change(handler)
        await _expect(RuntimeError, s.notify(_event(s)))


@check()
async def notify_rejects_anything_but_an_event(subject: Subject) -> None:
    async with subject.source() as s:
        await _expect(TypeError, s.notify({"kind": "upsert"}))  # type: ignore[arg-type]


# ── the family: what the items ARE ─────────────────────────────────────────


async def _first_page(subject: Subject) -> list:
    """The first listed page, or nothing for a push-only source (its items never come from a listing)."""
    if not issubclass(type(subject.source()), Listable):
        return []
    async with await _closing(subject) as s:
        return list((await s.fetch()).items)  # type: ignore[attr-defined]


@check(ObjectSource)
async def a_file_source_lists_files(subject: Subject) -> None:
    for item in await _first_page(subject):
        assert isinstance(item.data, FileData), f"{type(item.data).__name__} is not a file"


@check(RecordSource)
async def a_record_source_lists_records_never_files(subject: Subject) -> None:
    if issubclass(type(subject.source()), MessageSource):
        return  # the message check below holds it to the tighter family
    for item in await _first_page(subject):
        assert isinstance(item.data, RecordData), f"{type(item.data).__name__} is not a record"


@check(MessageSource)
async def a_message_source_lists_messages_and_can_answer(subject: Subject) -> None:
    assert issubclass(type(subject.source()), Messaging), "a message source sends and replies"
    for item in await _first_page(subject):
        assert isinstance(item.data, MessageData), f"{type(item.data).__name__} is not a message"


# ── Readable ───────────────────────────────────────────────────────────────


@check(Readable)
async def get_returns_the_item_with_the_requested_identity(subject: Subject) -> None:
    async with await _closing(subject) as s:
        item = await s.get(subject.seeded[0])  # type: ignore[attr-defined]
        assert item is not None and item.origin == subject.seeded[0]


@check(Readable)
async def get_of_an_unknown_key_is_none(subject: Subject) -> None:
    async with await _closing(subject) as s:
        assert await s.get(s.origin("conformance-missing-key")) is None  # type: ignore[attr-defined]


@check(Readable)
async def get_of_a_foreign_origin_is_a_value_error(subject: Subject) -> None:
    async with await _closing(subject) as s:
        foreign = CloudOrigin(kind="conformance", namespace="elsewhere", key="x")
        await _expect(ValueError, s.get(foreign))  # type: ignore[attr-defined]


@check(Readable)
async def get_of_a_non_origin_is_a_type_error(subject: Subject) -> None:
    async with await _closing(subject) as s:
        await _expect(TypeError, s.get("not-an-origin"))  # type: ignore[attr-defined,arg-type]


# ── Listable ───────────────────────────────────────────────────────────────


@check(Listable)
async def pages_chain_to_the_end_and_cover_iterate(subject: Subject) -> None:
    async with await _closing(subject) as s:
        paged: list[CloudOrigin] = []
        cursor = None
        for _ in range(10_000):
            page = await s.fetch(cursor=cursor, page_size=1)  # type: ignore[attr-defined]
            assert len(page.items) <= 1
            paged.extend(item.origin for item in page.items)
            cursor = page.next_cursor
            if cursor is None:
                break
        else:
            raise AssertionError("the cursor chain never ended")
        iterated = [item.origin async for item in s.iterate()]  # type: ignore[attr-defined]
        assert paged == iterated
        assert set(subject.seeded) <= set(paged)


@check(Listable)
async def page_size_is_validated(subject: Subject) -> None:
    async with await _closing(subject) as s:
        await _expect(ValueError, s.fetch(page_size=0))  # type: ignore[attr-defined]
        await _expect(TypeError, s.fetch(page_size=True))  # type: ignore[attr-defined]
        await _expect(ValueError, s.fetch(page_size=10**9))  # type: ignore[attr-defined]


@check(Listable)
async def a_foreign_cursor_is_invalid(subject: Subject) -> None:
    async with await _closing(subject) as s:
        await _expect(InvalidCursor, s.fetch(cursor="not-a-cursor"))  # type: ignore[attr-defined]


@check(Listable)
async def a_narrowing_the_query_does_not_have_is_refused(subject: Subject) -> None:
    async with await _closing(subject) as s:
        await _expect(ValueError, s.fetch(narrow={"no_such_field": 1}))  # type: ignore[attr-defined]


@check(Listable)
async def consuming_iterate_outside_a_session_is_a_runtime_error(subject: Subject) -> None:
    s = subject.source()
    gen = s.iterate()  # type: ignore[attr-defined]
    await _expect(RuntimeError, gen.__anext__())


# ── ByteStore ──────────────────────────────────────────────────────────────


async def _chunks(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


@check(ByteStore)
async def open_streams_the_bytes_in_bounded_chunks(subject: Subject) -> None:
    async with await _closing(subject) as s:
        item = await s.get(subject.seeded[0])  # type: ignore[attr-defined]
        assert isinstance(item, FileItem)
        total = b""
        async with s.open(item, chunk_size=3) as chunks:  # type: ignore[attr-defined]
            async for chunk in chunks:
                assert isinstance(chunk, bytes) and 0 < len(chunk) <= 3
                total += chunk
        assert item.data.size is None or len(total) == item.data.size


@check(ByteStore)
async def write_get_open_delete_round_trip(subject: Subject) -> None:
    async with await _closing(subject) as s:
        written = await s.write(subject.writable_path, _chunks(b"hello ", b"world"))  # type: ignore[attr-defined]
        assert written.data.path == subject.writable_path and written.data.size == 11
        again = await s.get(written.origin)  # type: ignore[attr-defined]
        assert again is not None and again.data.size == 11
        async with s.open(written) as chunks:  # type: ignore[attr-defined]
            assert b"".join([c async for c in chunks]) == b"hello world"
        await s.delete(written.origin)  # type: ignore[attr-defined]
        assert await s.get(written.origin) is None  # type: ignore[attr-defined]
        await s.delete(written.origin)  # already absent is success  # type: ignore[attr-defined]


@check(ByteStore)
async def an_empty_stream_writes_an_empty_file(subject: Subject) -> None:
    async with await _closing(subject) as s:
        written = await s.write(subject.writable_path, _chunks())  # type: ignore[attr-defined]
        assert written.data.size == 0
        async with s.open(written) as chunks:  # type: ignore[attr-defined]
            assert [c async for c in chunks] == []
        await s.delete(written.origin)  # type: ignore[attr-defined]


@check(ByteStore)
async def chunk_size_is_validated(subject: Subject) -> None:
    async with await _closing(subject) as s:
        item = await s.get(subject.seeded[0])  # type: ignore[attr-defined]
        assert isinstance(item, FileItem)
        await _expect(ValueError, lambda: s.open(item, chunk_size=0))  # type: ignore[attr-defined]
        await _expect(TypeError, lambda: s.open(item, chunk_size=True))  # type: ignore[attr-defined]
        await _expect(TypeError, lambda: s.open("x"))  # type: ignore[attr-defined,arg-type]


@check(ByteStore)
async def opening_a_missing_file_is_not_found(subject: Subject) -> None:
    async with await _closing(subject) as s:
        missing = FileItem(origin=s.origin("conformance-missing.bin"), data=FileData())

        async def attempt() -> None:
            async with s.open(missing):  # type: ignore[attr-defined]
                pass

        await _expect(NotFound, attempt())


@check(ByteStore)
async def write_refuses_bad_paths_and_non_bytes(subject: Subject) -> None:
    async with await _closing(subject) as s:
        await _expect(ValueError, s.write("/absolute", _chunks(b"x")))  # type: ignore[attr-defined]
        await _expect(ValueError, s.write("a/../b", _chunks(b"x")))  # type: ignore[attr-defined]
        await _expect(ValueError, s.write("", _chunks(b"x")))  # type: ignore[attr-defined]

        async def strings() -> AsyncIterator[bytes]:
            yield "text"  # type: ignore[misc]

        await _expect(TypeError, s.write(subject.writable_path, strings()))  # type: ignore[attr-defined]


# ── Mutable ────────────────────────────────────────────────────────────────


@check(Mutable)
async def create_returns_the_item_and_get_finds_it(subject: Subject) -> None:
    assert subject.create_data is not None, "a Mutable subject needs create_data"
    async with await _closing(subject) as s:
        created = await s.create(subject.create_data)  # type: ignore[attr-defined]
        found = await s.get(created.origin)  # type: ignore[attr-defined]
        assert found is not None and found.data == subject.create_data


@check(Mutable)
async def an_empty_update_is_refused_before_any_io(subject: Subject) -> None:
    async with await _closing(subject) as s:
        await _expect(ValueError, s.update(subject.seeded[0], {}))  # type: ignore[attr-defined]


@check(Mutable)
async def an_unknown_update_field_is_refused(subject: Subject) -> None:
    async with await _closing(subject) as s:
        await _expect(ValueError, s.update(subject.seeded[0], {"conformance_unknown_field": 1}))  # type: ignore[attr-defined]


@check(Mutable)
async def updating_a_missing_record_is_not_found(subject: Subject) -> None:
    assert subject.create_data is not None
    field_name = next(iter(type(subject.create_data).model_fields))
    async with await _closing(subject) as s:
        missing = s.origin("conformance-missing")
        await _expect(NotFound, s.update(missing, {field_name: getattr(subject.create_data, field_name)}))  # type: ignore[attr-defined]


@check(Mutable)
async def delete_is_unconditional_and_idempotent(subject: Subject) -> None:
    assert subject.create_data is not None
    async with await _closing(subject) as s:
        created = await s.create(subject.create_data)  # type: ignore[attr-defined]
        await s.delete(created.origin)  # type: ignore[attr-defined]
        assert await s.get(created.origin) is None  # type: ignore[attr-defined]
        await s.delete(created.origin)  # type: ignore[attr-defined]


# ── Messaging ──────────────────────────────────────────────────────────────


@check(Messaging)
async def send_needs_exactly_one_addressing_mode(subject: Subject) -> None:
    assert subject.conversation is not None and subject.recipient is not None
    async with await _closing(subject) as s:
        await _expect(ValueError, s.send(MessageData(text="hi")))  # type: ignore[attr-defined]
        both = MessageData(text="hi", conversation=subject.conversation, recipients=(subject.recipient,))
        await _expect(ValueError, s.send(both))  # type: ignore[attr-defined]


@check(Messaging)
async def provider_assigned_fields_must_be_empty_on_send(subject: Subject) -> None:
    assert subject.conversation is not None and subject.recipient is not None
    c = subject.conversation
    async with await _closing(subject) as s:
        await _expect(ValueError, s.send(MessageData(conversation=c)))  # type: ignore[attr-defined]
        await _expect(ValueError, s.send(MessageData(text="hi", conversation=c, sender=subject.recipient)))  # type: ignore[attr-defined]
        await _expect(ValueError, s.send(MessageData(text="hi", conversation=c, in_reply_to=c)))  # type: ignore[attr-defined]
        attachment = FileItem(origin=CloudOrigin(kind="x", namespace="y", key="z"), data=FileData())
        await _expect(ValueError, s.send(MessageData(text="hi", conversation=c, attachments=(attachment,))))  # type: ignore[attr-defined]
        await _expect(TypeError, s.send({"text": "hi"}))  # type: ignore[attr-defined,arg-type]


@check(Messaging)
async def send_to_a_conversation_returns_the_confirmed_message(subject: Subject) -> None:
    assert subject.conversation is not None
    async with await _closing(subject) as s:
        sent = await s.send(MessageData(text="The report is ready.", conversation=subject.conversation))  # type: ignore[attr-defined]
        assert isinstance(sent, MessageItem)
        assert sent.data.conversation == subject.conversation and sent.data.text == "The report is ready."
        if isinstance(s, Readable):
            assert await s.get(sent.origin) is not None


@check(Messaging)
async def send_to_an_unknown_conversation_is_not_found(subject: Subject) -> None:
    async with await _closing(subject) as s:
        unknown = s.origin("conformance-unknown-conversation")
        await _expect(NotFound, s.send(MessageData(text="hi", conversation=unknown)))  # type: ignore[attr-defined]


@check(Messaging)
async def send_to_recipients_reports_the_conversation_it_landed_in(subject: Subject) -> None:
    assert subject.recipient is not None
    async with await _closing(subject) as s:
        try:
            sent = await s.send(MessageData(text="hello", recipients=(subject.recipient,)))  # type: ignore[attr-defined]
        except Unsupported:
            return  # an addressing mode the source cannot perform is declared, never faked
        assert sent.data.conversation is not None


@check(Messaging)
async def reply_is_routed_from_the_answered_message(subject: Subject) -> None:
    assert subject.conversation is not None
    async with await _closing(subject) as s:
        sent = await s.send(MessageData(text="question", conversation=subject.conversation))  # type: ignore[attr-defined]
        reply = await s.reply(sent.origin, MessageData(text="answer"))  # type: ignore[attr-defined]
        assert reply.origin != sent.origin
        assert reply.data.in_reply_to == sent.origin and reply.data.conversation == subject.conversation
        await _expect(ValueError, s.reply(sent.origin, MessageData(text="x", conversation=subject.conversation)))  # type: ignore[attr-defined]
        await _expect(NotFound, s.reply(s.origin("conformance-missing"), MessageData(text="x")))  # type: ignore[attr-defined]


# ── Drafting ───────────────────────────────────────────────────────────────


@check(Drafting)
async def a_draft_is_a_resource_and_never_a_sent_message(subject: Subject) -> None:
    assert subject.conversation is not None
    async with await _closing(subject) as s:
        draft = await s.draft(MessageData(text="later", conversation=subject.conversation))  # type: ignore[attr-defined]
        assert isinstance(draft, MessageItem) and draft.data.sent_at is None
        if isinstance(s, Messaging):
            sent = await s.send(MessageData(text="now", conversation=subject.conversation))
            assert sent.origin != draft.origin


# ── plumbing ───────────────────────────────────────────────────────────────


class _Closing:
    def __init__(self, s: Source) -> None:
        self.s = s

    async def __aenter__(self) -> Any:
        return self.s

    async def __aexit__(self, *exc: Any) -> None:
        await self.s.__aexit__(*exc)


async def _closing(subject: Subject) -> _Closing:
    return _Closing(await subject.opened())


__all__ = ["Check", "Subject", "check", "checks_for", "run_all"]

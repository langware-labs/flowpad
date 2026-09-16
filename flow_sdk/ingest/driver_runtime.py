"""What a ``DataDriver`` does at run time — the registry of loaded drivers, and one segment's traversal.

A ``DataDriver`` (``flow_sdk/builtin/data_driver.py``) is one data source driver as the application
runs it: the folder's ``Source`` class
and its manifest (``flow_sdk/ingest/driver_registry.py`` loads both). Everything that differs between
sources the class or the manifest says — the credential shape (``auth``), the transport it is built
over (``build``), how a send's arguments address its channel (``message_for``), how a cursor an older
build left is adopted (``lift_cursor``), the identity a reflected file resolves on
(``origin_id_for``). The sync engine, reflection and the inbox ask the type; nothing here, or
anywhere outside an asset folder, names a provider.

**One segment's traversal** (``DataDriver.traverse``) is the engine step: a page chain capped by
``pages_per_pass``, starting from the durable cursor when the class declares one, else from the
row's window. A record source's items lower to the flat envelope in the order they happened; a
reflecting source's files become refs diffed against the manifest the cursor row carries — an
observed stamp per key plus, when the source can say, a handle that survives a rename. A remote
file source's changed bytes are pulled through ``open`` into the row's cache first.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.capsules.atomic import atomic_write
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.sources.base import Source
from flow_sdk.sources.binding import Persona, SourceBinding
from flow_sdk.sources.credentials import Credentials
from flow_sdk.sources.errors import Rejected, SourceError
from flow_sdk.sources.protocols import (
    Choosing,
    Identified,
    Listable,
    Messaging,
    Segmented,
    StableHandle,
    Verdict,
    Verifiable,
)
from flow_sdk.sources.values.page import ChangePage
from flow_sdk.sources.values.query import MessageQuery
from flow_sdk.sources.values.segment import SegmentRef
from flow_sdk.utils.kind_registry import KindRegistry
from flow_sdk.utils.serialization import iso_to_utc

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.source_item import MessageSpec
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.schema.data_spec.data_driver_spec import DataDriverSpec

logger = logging.getLogger(__name__)

#: The one segment of a source that does not split its selection.
ROOT_SEGMENT = "root"
#: Remote objects pulled at once into a cache. Small on purpose: each is held whole in memory
#: before its atomic write, so the gate bounds peak RSS as much as sockets.
DOWNLOAD_CONCURRENCY = 4
#: The `context_data` key naming the source a spawned worker belongs to. Paired with
#: `SCOPES["data_source_id"]` (server/routes/runs.py) and `PROCESS_RUN_SCOPE_KEYS`
#: (ui/src/navigation/DockPointer.ts): an ingest worker has no spawning entity to browse from.
RUN_SOURCE_KEY = "data_source_id"

_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


# ── the send outcome (until the messaging verbs return a MessageItem) ──────────


class SendStatus(StrEnum):
    """What became of an outbound message. ``DRAFTED``: composed for the user to send — a real
    outcome that has reached nobody, so it is never recorded as a message."""

    SENT = "sent"
    DRAFTED = "drafted"


@dataclass(frozen=True)
class SendOutcome:
    """What the channel confirmed about one message. ``recorded`` is load-bearing: False on a SENT
    message means the mail is gone but the local copy is missing, and re-sending to fix the
    bookkeeping would mail the recipient twice."""

    external_id: str = ""
    status: SendStatus = SendStatus.SENT
    recorded: bool = False
    artifact_id: str = ""

    @property
    def drafted(self) -> bool:
        return self.status is SendStatus.DRAFTED


# ── one segment's position and what a traversal of it found ────────────────────


@dataclass(frozen=True)
class SegmentPosition:
    """Where a segment's last traversal left off. ``legacy_state`` is the dict an older build kept
    on the cursor row; it is read once, through the type's ``lift_cursor``, and never written."""

    segment_key: str
    cursor: Optional[str] = None
    manifest: dict = field(default_factory=dict)
    legacy_state: dict = field(default_factory=dict)
    window_start: Optional[str] = None


@dataclass(frozen=True)
class SegmentPass:
    """One traversal's findings: records OR files, and the position to carry to the next one."""

    items: list = field(default_factory=list)
    refs: list[str] = field(default_factory=list)
    tombstones: list[str] = field(default_factory=list)
    renames: dict[str, str] = field(default_factory=dict)
    cursor: Optional[str] = None
    manifest: dict = field(default_factory=dict)
    #: Greatest ordinal covered — observability only, never read back as a floor.
    high_water: Optional[str] = None
    unchanged: bool = False


# ── identity and provenance ────────────────────────────────────────────────────


def identity_stamped(row: Any) -> bool:
    """Whether ``row`` already knows which account it reads as."""
    return bool(getattr(row, "account_key", "") or getattr(row, "account_identities", None))


async def stamp_identity(row: Any, *, account_key: str, identities: list[str]) -> None:
    """Record the account a source reads and posts as: without it the inbox attributes our own
    posts to a stranger and a listening loop answers itself."""
    row.account_key = account_key
    row.account_identities = [v for v in identities if v]
    await row.save_runtime()


def ingest_run_context(row: Any) -> dict[str, str]:
    """The provenance every ingest-spawned worker carries."""
    return {RUN_SOURCE_KEY: str(getattr(row, "id", "") or "")}


# ── the cache a remote file source's bytes land in ─────────────────────────────


def cached_path(root: Path, key: str) -> Optional[Path]:
    """Where a remote object's bytes land under ``root``, or ``None`` when its key cannot be a
    path. A key is provider input and may hold ``..`` or only separators: refused where it meets
    the local filesystem, never coerced into a guess."""
    parts = [part for part in key.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        return None
    return root.joinpath(*(part.replace("\\", "_") for part in parts))


#: Each cache index as last read, stamped ``(mtime, size)``: reflection asks for an origin twice
#: per ref, and re-parsing an index of a whole drive per call is quadratic.
_INDEX_CACHE: dict[Path, tuple[tuple[int, int], dict[str, str]]] = {}


def cache_index_path(root: Path, provider: str) -> Path:
    return root / f".{provider}-index.json"


def read_cache_index(root: Path, provider: str) -> dict[str, str]:
    """The cache's ``{path: key}`` index — empty when absent or unreadable."""
    path = cache_index_path(root, provider)
    try:
        st = path.stat()
    except OSError:
        return {}
    stamp = (st.st_mtime_ns, st.st_size)
    cached = _INDEX_CACHE.get(path)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    try:
        loaded = {str(rel): str(key) for rel, key in json.loads(path.read_text(encoding="utf-8")).items()}
    except (OSError, ValueError, AttributeError):
        return {}
    _INDEX_CACHE[path] = (stamp, loaded)
    return loaded


def write_cache_index(root: Path, provider: str, index: dict[str, str]) -> None:
    atomic_write(cache_index_path(root, provider), json.dumps(index, indent=2, sort_keys=True).encode("utf-8"))


def _place_without_collisions(wanted: dict[str, str], known: dict[str, str]) -> dict[str, str]:
    """Each key's cache path, never shared with another key.

    A remote file's ``path`` is its name, and names are not unique (Drive keeps several files called
    ``report.csv`` side by side): the same path for two keys would overwrite one with the other and
    hand both refs one identity. A key keeps the placement it already has; a key whose wanted path
    another key holds gets a stable, distinct one carrying its own key.
    """
    owners = {rel: key for key, rel in known.items()}
    placed: dict[str, str] = {}
    for key, rel in wanted.items():
        distinct = _distinct_path(rel, key)
        if known.get(key) in (rel, distinct):
            placed[key] = known[key]
        elif owners.get(rel, key) != key:
            placed[key] = distinct
        else:
            placed[key] = rel
        owners[placed[key]] = key
    return placed


def _distinct_path(rel: str, key: str) -> str:
    """``dir/name~<key prefix>.ext`` — the same file name, told apart by its key."""
    head, _, name = rel.rpartition("/")
    stem, dot, suffix = name.rpartition(".")
    tag = "".join(ch for ch in key if ch.isalnum())[:10] or "x"
    renamed = f"{stem}~{tag}.{suffix}" if dot and stem else f"{name}~{tag}"
    return f"{head}/{renamed}" if head else renamed


async def _pull(source: Source, wanted: list) -> None:
    """Each ``(item, path)``'s bytes, through the source's ``open``, atomically into place — a pass
    that dies mid-download never leaves a half file for the indexer to type."""
    gate = asyncio.Semaphore(DOWNLOAD_CONCURRENCY)

    async def one(item: Any, path: Path) -> None:
        async with gate:
            async with source.open(item) as chunks:  # type: ignore[attr-defined]
                content = b"".join([chunk async for chunk in chunks])
            atomic_write(path, content)

    await asyncio.gather(*(one(item, path) for item, path in wanted))


# ── binding a row ──────────────────────────────────────────────────────────────


def binding_of(row: Any, *, credentials: Optional[Credentials] = None, persona: Optional[Persona] = None) -> SourceBinding:
    credentials = credentials or Credentials()
    # A secret the resolver lifted out of the row never also rides in ``config``.
    raw = getattr(row, "config", None) or {}
    driver = DRIVERS.get_or_none(str(getattr(row, "provider", "") or ""))
    config_cls = getattr(driver.cls, "Config", None) if driver is not None else None
    # A driver with a ``Config`` reads its stored config as well as it still validates.
    typed = config_cls.best_match(raw) if config_cls is not None else raw
    config = {k: v for k, v in typed.items() if k not in credentials.values}
    return SourceBinding(
        source_id=str(getattr(row, "id", "") or ""),
        name=str(getattr(row, "provider", "") or ""),
        account_key=str(getattr(row, "account_key", "") or ""),
        config=config,
        credentials=credentials,
        persona=persona or Persona(),
    )


async def _persona_of(row: Any) -> Persona:
    from flow_sdk.inbox.sender_identity import sender_identity  # noqa: PLC0415

    identity = await sender_identity(row)
    return Persona(name=identity.username, icon=identity.icon_emoji) if identity else Persona()


def _when(item: Any) -> Any:
    """The event time an item's payload reports — the window, the order and the high-water read it."""
    return getattr(item.data, "sent_at", None) or getattr(item.data, "published_at", None)


async def _single_segment(source: Source) -> str:
    """The key of a source's one segment, else ``root``."""
    if isinstance(source, Segmented):
        refs = await source.segments()
        if len(refs) == 1:
            return refs[0].key
    return ROOT_SEGMENT


class DriverRuntime:
    """The run-time half of ``DataDriver``: build, bind, traverse, send. A mixin, so the registry
    holds the entity itself; its state (``_cls``, ``_manifest``, ``_folder``, ...) is the entity's
    private attributes, set by ``DataDriver.for_class``."""

    _cls: type[Source]
    _manifest: "Optional[DataDriverSpec]"
    _folder: Optional[Path]
    _content_hash: str
    _shipped: bool
    kind: str
    name: str

    @property
    def cls(self) -> type[Source]:
        return self._cls

    @property
    def provider(self) -> str:
        return self.name

    @property
    def manifest(self) -> "Optional[DataDriverSpec]":
        return self._manifest

    @property
    def folder(self) -> Optional[Path]:
        """The asset folder the driver loaded from; ``None`` for a class registered by hand (a test's)."""
        return self._folder

    @property
    def content_hash(self) -> str:
        """The folder's code as it loaded — a changed ``source.py`` is loaded again."""
        return self._content_hash

    @property
    def shipped(self) -> bool:
        """Loaded from the wheel's own folders: never reloaded, never shadowed."""
        return self._shipped

    # ── traits the application reads ───────────────────────────────────────
    @property
    def can_send(self) -> bool:
        return issubclass(self.cls, Messaging) and callable(getattr(self.cls, "message_for", None))

    @property
    def has_setup(self) -> bool:
        return issubclass(self.cls, Verifiable)

    @property
    def offers_choices(self) -> bool:
        return callable(getattr(self.cls, "choices_for", None)) or issubclass(self.cls, Choosing)

    @property
    def finds_replies(self) -> bool:
        """A transport that can look one response up by what it answers (Gmail's In-Reply-To scan)."""
        return hasattr(self.cls, "find_reply")

    @property
    def open_inbound(self) -> bool:
        return self.cls.open_inbound

    @property
    def identity_config_key(self) -> str:
        return self.cls.identity_config_key

    @property
    def connection(self) -> Optional[str]:
        return self.cls.connection

    @property
    def attention_poll_seconds(self) -> Optional[int]:
        return self.cls.attention_poll_seconds

    @property
    def segment_budget(self) -> Optional[int]:
        return self.cls.segment_budget

    @property
    def stamps_identity(self) -> bool:
        return self.cls.stamps_identity

    @property
    def reflects(self) -> bool:
        return self.cls.reflects

    def channel_for(self, row: Any) -> str:
        """The user-facing channel a row reaches; a file source has none."""
        if self.cls.reflects:
            return ""
        return str(self.cls.origin_kind_for(getattr(row, "config", None) or {}) or "")

    def outbound_spec(self, row: Any) -> type["MessageSpec"]:
        """The spec class that knows WHO a reply on this channel is addressed to."""
        declared = self.cls.outbound_spec()
        if declared is not None:
            return declared
        from flow_sdk.builtin.source_item import EmailMessageSpec  # noqa: PLC0415

        return EmailMessageSpec

    # ── instances ───────────────────────────────────────────────────────────
    def create_source(self, config: Optional[dict] = None, *, name: str, **authored: Any) -> "DataSource":
        """A configured instance of this driver, in memory: nothing is written until ``save()``.

        ``await source.save()`` places ``data_source.json`` in the project scope (the request's
        project, the owning agent's, else the working directory's) and checks the config.
        """
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

        return DataSource(provider=self.provider, name=name, kind=self.kind, config=dict(config or {}), **authored)

    # ── binding ─────────────────────────────────────────────────────────────
    async def credentials_for(self, row: Any) -> Credentials:
        """What the row reads with, resolved from the manifest's ``auth``."""
        from flow_sdk.ingest.credentials import resolve_credentials  # noqa: PLC0415

        return await resolve_credentials(self.manifest.auth if self.manifest is not None else None, row)

    async def open(self, row: Any, *, persona: bool = False, credentials: Optional[Credentials] = None) -> Source:
        """The configured source (not yet in a session). A configuration the class refuses is a
        person's to fix. ``credentials`` already resolved for this row skip the second resolve."""
        credentials = credentials if credentials is not None else await self.credentials_for(row)
        binding = binding_of(row, credentials=credentials, persona=await _persona_of(row) if persona else None)
        derived = dict(self.cls.configure(row) or {})
        if derived:
            binding = binding.model_copy(update={"config": {**binding.config, **derived}})
        try:
            return self.cls.build(binding)
        except ValueError as exc:
            raise Rejected(str(exc)) from exc

    # ── where a reflecting source's files are ───────────────────────────────
    def cache_root(self, row: Any) -> Optional[Path]:
        """Where a REMOTE file source's bytes land: under this instance, not a project, so deleting
        the source can take its cache without touching anything a person wrote. ``None`` for a
        source with no remote bytes."""
        if not self.cls.reflects or self.cls.local_tree_key:
            return None
        override = (getattr(row, "config", None) or {}).get("cache_root")
        if override:
            return Path(str(override)).expanduser().resolve()
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        return (get_instance_settings().instance_dir / self.provider / str(getattr(row, "id", "") or "")).resolve()

    def tree_root(self, row: Any) -> Optional[Path]:
        """The tree every ref of a reflecting source is relative to: the local tree the source reads
        in place, else its cache. ``None`` when the row does not name one yet."""
        key = self.cls.local_tree_key
        if not key:
            return self.cache_root(row)
        raw = str((getattr(row, "config", None) or {}).get(key) or "")
        return Path(raw).expanduser().resolve() if raw else None

    def origin_for(self, row: Any) -> Any:
        """The tree, as the origin a reflecting row is stamped with on save; ``None`` for a record
        source or a row that names no tree yet."""
        if not self.cls.reflects:
            return None
        root = self.tree_root(row)
        if root is None:
            return None
        from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415

        return local_origin_for_path(root)

    def origin_id_for(self, row: Any, ref: str) -> str:
        """The identity reflection resolves an unstamped file on, from the class; ``""`` falls back
        to the path."""
        root = self.tree_root(row)
        return str(self.cls.origin_id_for(row, ref, root) or "") if root is not None else ""

    async def segments(self, row: Any) -> list[SegmentRef]:
        source = await self.open(row)
        if not isinstance(source, Segmented):
            return [SegmentRef(key=ROOT_SEGMENT)]
        async with source:
            return list(await source.segments())

    # ── one segment's traversal ─────────────────────────────────────────────
    async def traverse(self, row: Any, position: SegmentPosition) -> SegmentPass:
        if not issubclass(self.cls, Listable):
            # A push-only source (a webhook is its only delivery): a poll finds nothing.
            return SegmentPass(cursor=position.cursor, manifest=dict(position.manifest), unchanged=True)
        source = await self.open(row)
        cls = type(source)
        async with source:
            segment = None
            if isinstance(source, Segmented):
                segment = next((ref for ref in await source.segments() if ref.key == position.segment_key), None)
            query = segment.query if segment else None
            cursor = None
            if cls.durable_cursor:
                cursor = position.cursor or (cls.lift_cursor(position.legacy_state) if position.legacy_state else None)
            complete = cursor is None
            started_at = cursor
            floor = iso_to_utc(position.window_start) if position.window_start else None
            if cursor is None and floor is not None and isinstance(query, MessageQuery) and query.since is None:
                query = query.model_copy(update={"since": floor})
            items, removed, moved, resume, pages = [], [], [], None, 0
            while True:
                page = await source.fetch(query, cursor=cursor)
                pages += 1
                items.extend(page.items)
                if isinstance(page, ChangePage):
                    removed.extend(page.removed)
                    moved.extend(page.moved)
                    resume = page.resume_cursor or resume
                cursor = page.next_cursor
                if cursor is None or (cls.pages_per_pass is not None and pages >= cls.pages_per_pass):
                    break
            # An idle traversal hands back no new resume point: the position it started from stands.
            carried = (resume or started_at) if cls.durable_cursor else None
            if cls.reflects:
                manifest = position.manifest or dict(position.legacy_state.get("manifest") or {})
                return await self._files(row, source, items, removed, moved, carried, manifest, complete=complete)
            return self._records(row, position, segment, items, carried, floor, moved_on=carried != started_at)

    def _records(self, row: Any, position: SegmentPosition, segment, items, cursor: Optional[str], floor, *, moved_on: bool) -> SegmentPass:
        kept = sorted(
            (item for item in items if floor is None or (_when(item) or floor) >= floor),
            key=lambda item: _when(item) or _EPOCH,
        )
        label = segment.label if segment else ""
        envelopes = [
            envelope_of(item, data_source_id=str(row.id), provider=self.provider, segment_key=position.segment_key, segment_label=label)
            for item in kept
        ]
        stamps = [when for when in map(_when, kept) if when is not None]
        return SegmentPass(
            items=envelopes,
            cursor=cursor,
            high_water=max(stamps).isoformat() if stamps else None,
            # Nothing arrived and the position did not move: the free no-op a 304 or an empty page is.
            unchanged=not items and not moved_on,
        )

    async def _files(self, row: Any, source: Source, items, removed, moved, cursor: Optional[str], previous: dict, *, complete: bool) -> SegmentPass:
        """A reflecting source's files as refs, diffed against the manifest.

        A traversal from the beginning is ``complete``: a key it no longer lists is gone. A delta
        traversal (resumed from a durable cursor) reports only what changed, so it merges into the
        manifest and only what the source says it removed is gone. A local tree's refs are its own
        paths under ``tree_root``. A remote one's bytes are pulled through ``open`` into the row's
        cache (``cache_root``), laid out along each file's ``path`` and indexed ``{path: key}`` beside
        them — reflection is handed a ref, never a cursor, and names identity from that index.
        """
        handle_of = source.handle_of if isinstance(source, StableHandle) else (lambda _item: "")
        by_key = {item.origin.key: item for item in items}
        root = self.cache_root(row)
        tree = None if root is not None else self.tree_root(row)
        placed: dict[str, str] = {}
        known: dict[str, str] = {}
        if root is not None:
            known = {key: rel for rel, key in read_cache_index(root, self.provider).items()}
            wanted = {key: getattr(item.data, "path", None) or key for key, item in by_key.items()}
            refused = [key for key, rel in wanted.items() if cached_path(root, rel) is None]
            if refused:
                # Never a silent drop: a source that quietly reflected 40 of 45 objects reads as complete.
                logger.info("[ingest] %s %s: skipped %d object(s) with no usable path", self.provider, row.id, len(refused))
            for key in refused:
                del by_key[key], wanted[key]
            placed = _place_without_collisions(wanted, known)

        def ref(key: str, rel: Optional[str] = None) -> Optional[str]:
            if root is None:
                assert tree is not None, f"{self.provider} reflects but its row names no {self.cls.local_tree_key or 'tree'}"
                return os.path.join(str(tree), key)
            path = cached_path(root, rel if rel is not None else known.get(key, key))
            return str(path) if path is not None else None

        observed = {key: [item.data.stable_dump(), handle_of(item)] for key, item in by_key.items()}
        changed = [key for key, entry in observed.items() if previous.get(key) != entry]
        # A moved-from key is neither live nor gone: identity travels to where it moved.
        moved_from = {move.previous.key for move in moved}
        if complete:
            current = observed
            live = {entry[1] for entry in current.values() if entry[1]}
            gone = [
                key for key, entry in previous.items()
                if key not in current and key not in moved_from and not (entry[1] and entry[1] in live)
            ]
        else:
            current, gone = {**previous, **observed}, []
        # A removal counts only for a key this source placed: a change log also reports files it never
        # listed (deleted elsewhere on the account), and those have nothing to tombstone.
        gone.extend(origin.key for origin in removed if origin.key in previous or origin.key in known)
        for key in (*gone, *moved_from):
            current.pop(key, None)
        renames = {ref(move.origin.key): ref(move.previous.key) for move in moved}
        tombstones = [r for key in dict.fromkeys(gone) if (r := ref(key))]
        if root is not None:
            # The same key under a new path is a rename the source reported by name alone (a Drive
            # rename keeps its fileId): identity travels, and the stale bytes leave the cache.
            relocated = {key: known[key] for key in changed if key in known and known[key] != placed[key]}
            renames.update({ref(key, placed[key]): ref(key) for key in relocated})
            await _pull(source, [(by_key[key], Path(ref(key, placed[key]))) for key in changed])
            for old in relocated.values():
                if (stale := cached_path(root, old)) is not None:
                    stale.unlink(missing_ok=True)
            kept = {key: rel for key, rel in known.items() if key in current}
            write_cache_index(root, self.provider, {rel: key for key, rel in {**kept, **placed}.items()})
        return SegmentPass(
            refs=[r for key in changed if (r := ref(key, placed.get(key)))],
            tombstones=tombstones,
            renames=renames,
            cursor=cursor,
            manifest=current,
            high_water=str(len(current)),
            unchanged=not changed and not gone and not renames,
        )

    # ── messaging ───────────────────────────────────────────────────────────
    async def send(
        self,
        row: Any,
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        conversation_id: str = "",
        in_reply_to: str = "",
    ) -> SendOutcome:
        """One message into the channel, recorded. A refused message is a ``ValueError`` — one failed
        reply must never become source health."""
        if not self.can_send:
            raise NotImplementedError(f"{self.provider} cannot send")
        source = await self.open(row, persona=True)
        data, answered = source.message_for(  # type: ignore[attr-defined]
            thread_key=thread_key, to=to, text=text, subject=subject, in_reply_to=in_reply_to, conversation_id=conversation_id
        )
        try:
            async with source:
                sent = await (source.reply(answered, data) if answered is not None else source.send(data))  # type: ignore[attr-defined]
        except SourceError as exc:
            raise ValueError(f"{self.provider} refused the message: {exc}") from exc
        if isinstance(source, Identified):
            await self._stamp(row, source)
        # A transport whose connector may only DRAFT reports the draft with no `sent_at`; one that
        # records its own copy says so on the payload.
        drafted = bool(getattr(type(source), "sends_may_draft", False)) and sent.data.sent_at is None
        if drafted or type(source).echoes_sends:
            recorded = bool(getattr(sent.data, "recorded", False))
        else:
            recorded = await self._record(row, source, sent)
        return SendOutcome(
            external_id=sent.origin.key,
            status=SendStatus.DRAFTED if drafted else SendStatus.SENT,
            recorded=recorded,
            artifact_id=str(getattr(sent.data, "artifact_id", "") or ""),
        )

    async def _record(self, row: Any, source: Source, sent: Any) -> bool:
        """Ingest a sent message the provider will never echo back — without it a conversation shows
        only its inbound half. After identity is stamped, so the copy reads as ours."""
        from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415

        segment = await _single_segment(source)
        try:
            await ingest_items([envelope_of(sent, data_source_id=str(row.id), provider=self.provider, segment_key=segment)])
        except Exception:  # noqa: BLE001 — the message IS delivered; bookkeeping must not unsend it
            logger.exception("[ingest] %s sent %s but could not record the copy", self.provider, sent.origin.key)
            return False
        return True

    async def ingest_pushed(self, row: Any, payload: Any, *, headers: Any = None, raw: bytes = b"") -> dict:
        """A provider's push delivery (a webhook body), as the records it carries, through the one
        ingestion chokepoint. Total: a payload carrying nothing we render ingests nothing.

        A class that can prove a delivery came from its provider (``webhook_authentic``) must: the
        delivery is refused with ``Rejected`` before anything is read, whoever calls this."""
        from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415

        credentials = await self.credentials_for(row)
        authentic = getattr(self.cls, "webhook_authentic", None)
        if authentic is not None and not authentic(headers or {}, raw, credentials):
            raise Rejected("the delivery's signature did not verify")
        source = await self.open(row, credentials=credentials)
        async with source:
            events = source.events_from_webhook(payload)  # type: ignore[attr-defined]
            segment = await _single_segment(source)
        items = [
            envelope_of(
                event.item,
                data_source_id=str(row.id),
                provider=self.provider,
                segment_key=segment,
                segment_label=str(getattr(getattr(event.item.data, "conversation", None), "key", "") or ""),
            )
            for event in events
            if event.item is not None
        ]
        if not items:
            return {"ingested": 0}
        report = await ingest_items(items)
        return {"ingested": len(items), "created": getattr(report, "created", 0)}

    async def find_reply(self, row: Any, external_id: str) -> Any:
        """The reply to ``external_id`` as an envelope, or ``None`` — one look."""
        source = await self.open(row)
        item = await source.find_reply(external_id)  # type: ignore[attr-defined]
        if item is None:
            return None
        return envelope_of(item, data_source_id=str(row.id), provider=self.provider, segment_key=await _single_segment(source))

    async def wait_for_reply(self, row: Any, external_id: str) -> Any:
        """Look again until the response exists. The caller owns the deadline, so there is no second
        timeout or sleep here to disagree with it."""
        while True:
            reply = await self.find_reply(row, external_id)
            if reply is not None:
                return reply

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self, row: Any) -> Verdict:
        """Whether setup is finished. A source with no setup step is ready once configured."""
        if not self.has_setup:
            return Verdict(ready=True)
        try:
            source = await self.open(row)
        except Rejected as exc:
            return Verdict(ready=False, detail=str(exc))
        verdict = await source.verify()  # type: ignore[attr-defined]
        if (verdict.ready or verdict.pending) and isinstance(source, Identified):
            await self._stamp(row, source)
        return verdict

    async def _stamp(self, row: Any, source: Source) -> None:
        """Record who the source reads and posts as, once."""
        if identity_stamped(row):
            return
        try:
            profiles = await source.whoami()  # type: ignore[attr-defined]
            if profiles:
                identities = [p.origin.key for p in profiles] + [p.name for p in profiles if p.name]
                await stamp_identity(row, account_key=profiles[0].name or profiles[0].origin.key, identities=identities)
        except Exception:  # noqa: BLE001 — identity is a nicety; it never fails what asked for it
            logger.debug("[ingest] %s identity stamp failed", self.provider, exc_info=True)

    async def choices(self, row: Any, field: str) -> list:
        """What the credential can see for one config field. Raises like a fetch; the one caller
        (``DataSource.choices_for``) turns a refusal into a sentence. A field whose offer is
        APPLICATION state (the desks this instance adopted) the class answers from that state."""
        if callable(getattr(self.cls, "choices_for", None)):
            return list(await self.cls.choices_for(row, field))  # type: ignore[attr-defined]
        from flow_sdk.schema.data_spec.choice_spec import Choice  # noqa: PLC0415

        async with await self.open(row) as source:
            offered = await source.choices(field)  # type: ignore[attr-defined]
        return [Choice(**{k: str(entry[k]) for k in ("id", "name", "detail") if entry.get(k)}) for entry in offered]


def _register_shipped(registry: "KindRegistry[DataDriver]") -> None:
    from flow_sdk.ingest.driver_registry import register_shipped  # noqa: PLC0415

    register_shipped(registry)


#: Keyed by provider; the shipped asset folders load on the first lookup. A miss answers ``None`` —
#: an unknown provider is a diagnosable source state (``unknown_provider``), not a crash in the poller.
DRIVERS: "KindRegistry[DataDriver]" = KindRegistry("data driver", key="provider", builder=_register_shipped)


__all__ = [
    "DOWNLOAD_CONCURRENCY",
    "ROOT_SEGMENT",
    "RUN_SOURCE_KEY",
    "DRIVERS",
    "SegmentPass",
    "SegmentPosition",
    "SendOutcome",
    "SendStatus",
    "DriverRuntime",
    "binding_of",
    "cache_index_path",
    "cached_path",
    "identity_stamped",
    "ingest_run_context",
    "read_cache_index",
    "stamp_identity",
    "write_cache_index",
]

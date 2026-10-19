"""``AgentTranscriptFile`` — eager-parsed unified transcript across workers."""

from __future__ import annotations

import copy
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from .derivation.registry import _derive_from
from .derive import derive_entries
from .entries import (
    AssistantMessageEntry,
    FileReadEntry,
    MetaEntry,
    ShellCommandEntry,
    ToolResultEntry,
    ToolUseEntry,
    UsageEntry,
    UserMessageEntry,
)
from .entry import EntryKind, TranscriptEntry
from .formats import TranscriptFormat
from .parsers import get_parser_class

# Outputs longer than this are truncated when folded into a semantic call
# entry. Keeps payloads bounded over the wire — the full output is still
# available on the original ToolResultEntry when the catch-all path is used.
_FOLD_PREVIEW_MAX_CHARS = 4000

# The kinds a ``ToolResultEntry`` folds INTO (one row per agent operation).
# Catch-all ``ToolUseEntry`` results stay standalone — see
# ``AgentTranscriptFile._fold_tool_results``.
_SEMANTIC_CALL_KINDS = frozenset({
    EntryKind.SHELL_COMMAND,
    EntryKind.FILE_READ,
    EntryKind.FILE_WRITE,
    EntryKind.FILE_EDIT,
})

# User-message texts that are synthetic (Claude Code injects them on user
# interrupts). They're "user" lines in the JSONL but the human didn't type
# them — drop from the prompts collection.
_SYNTHETIC_USER_TEXTS = frozenset({
    "[Request interrupted by user for tool use]",
})

if TYPE_CHECKING:
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

    from .pricing.base import ModelPricing

logger = logging.getLogger(__name__)


def _apply_tool_result(target: TranscriptEntry, result: ToolResultEntry) -> None:
    """Fold ``result``'s payload into the semantic call it answers.

    The ONE rule for what a result contributes to its call, shared by the full
    fold (``_fold_tool_results``) and the incremental one (``_FoldState.feed``).
    Mutates ``target`` — callers hand it a copy when the original must stay
    pristine.
    """
    output = result.tool_output or ""
    # Preserve the result's error flag on the surviving call entry —
    # modern Claude Bash results carry no exitCode, only the block's
    # is_error, so dropping the row would lose the failure signal.
    if result.is_error and not getattr(target, "is_error", False):
        target.is_error = True
    if isinstance(target, ShellCommandEntry):
        if target.exit_code is None and result.exit_code is not None:
            target.exit_code = result.exit_code
        if target.duration_ms is None and result.duration_ms is not None:
            target.duration_ms = result.duration_ms
        if target.stdout_preview is None and output:
            target.stdout_preview = output[:_FOLD_PREVIEW_MAX_CHARS]
    elif isinstance(target, FileReadEntry):
        if target.bytes_count is None and output:
            target.bytes_count = len(output.encode("utf-8"))
        if target.content_preview is None and output:
            target.content_preview = output[:_FOLD_PREVIEW_MAX_CHARS]
    # FileWriteEntry / FileEditEntry: result is usually a one-line
    # "Updated …" — no field worth surfacing. Result row is dropped.


def _fold_targets(unfolded: list[TranscriptEntry]) -> set[int]:
    """``id()`` of every entry a full fold will MUTATE: the first row of each
    multi-row assistant message, and every semantic call that has a result.
    Only those need a copy to keep ``_unfolded`` pristine — the rest can be
    shared with the folded list as-is.
    """
    first_row: dict[str, int] = {}
    targets: set[int] = set()
    calls: dict[str, int] = {}
    result_ids: set[str] = set()
    for e in unfolded:
        if isinstance(e, AssistantMessageEntry):
            if e.entry_id:
                if e.entry_id in first_row:
                    targets.add(first_row[e.entry_id])
                else:
                    first_row[e.entry_id] = id(e)
        elif isinstance(e, ToolResultEntry):
            if e.tool_use_id:
                result_ids.add(e.tool_use_id)
        else:
            tuid = getattr(e, "tool_use_id", None)
            if tuid and e.kind in _SEMANTIC_CALL_KINDS and tuid not in calls:
                calls[tuid] = id(e)
    targets.update(i for tuid, i in calls.items() if tuid in result_ids)
    return targets


class _NeedsFullRefold(Exception):
    """Raised by ``_FoldState.feed`` when the new tail cannot be folded
    locally — a write-order inversion the full fold resolves by seeing the
    whole list at once. The caller falls back to ``_refold_full``; nothing
    is retried or waited for."""


class _FoldState:
    """Fold indexes kept between deltas so a new line folds into the entries
    it belongs with, without touching the rest of the session.

    Built once from a full fold (``unfolded[:n]`` + the folded ``entries``)
    and then kept current by ``feed``. Every entry it holds is either shared
    with ``_unfolded`` or a copy made when a later line folded into it —
    **copy-on-write**: a folded entry that has been published in an earlier
    ``entries`` list is never mutated, its replacement is swapped in at the
    same index. Readers on the event loop keep a stable snapshot.
    """

    __slots__ = (
        "n", "buf", "pos", "assistants", "calls",
        "canonical", "mirrors", "loose", "known", "derived",
    )

    def __init__(self, unfolded: list[TranscriptEntry], entries: list[TranscriptEntry]) -> None:
        # How many of ``_unfolded`` are folded into ``buf``.
        self.n = len(unfolded)
        # The folded + derived list (what ``entries`` is a copy of).
        self.buf: list[TranscriptEntry] = list(entries)
        # Every id in ``buf`` — the ``known`` set ``_derive_from`` dedups on.
        self.known: set[str] = {e.id for e in entries}
        # Ids of derived (virtual) entries, to catch a physical id colliding.
        self.derived: set[str] = {e.id for e in entries if e.virtual}
        # id(obj) -> index in buf, fold targets only (what ``replace`` swaps).
        self.pos: dict[int, int] = {}
        # entry_id -> [survivor, texts, thinkings]: the pristine parts a
        # multi-row assistant message joins, so a later row re-joins exactly
        # what ``_fold_assistant_messages`` would.
        self.assistants: dict[str, list] = {}
        # tool_use_id -> the folded semantic call (first row per id).
        self.calls: dict[str, TranscriptEntry] = {}
        # tool_use_ids of results kept standalone (no semantic call to fold into).
        self.loose: set[str] = set()
        for i, e in enumerate(entries):
            if e.virtual:
                continue
            if isinstance(e, AssistantMessageEntry) and e.entry_id and e.entry_id not in self.assistants:
                self.assistants[e.entry_id] = [e, [], []]
                self.pos[id(e)] = i
            elif isinstance(e, ToolResultEntry):
                if e.tool_use_id:
                    self.loose.add(e.tool_use_id)
            else:
                tuid = getattr(e, "tool_use_id", None)
                if tuid and e.kind in _SEMANTIC_CALL_KINDS and tuid not in self.calls:
                    self.calls[tuid] = e
                    self.pos[id(e)] = i
        # Result ids seen, split by transport mirror vs canonical (see the
        # mirror note in ``_fold_tool_results``).
        self.canonical: set[str] = set()
        self.mirrors: set[str] = set()
        for u in unfolded:  # pristine parts, in source order
            if isinstance(u, AssistantMessageEntry) and u.entry_id:
                grp = self.assistants[u.entry_id]
                if u.text:
                    grp[1].append(u.text)
                if u.thinking:
                    grp[2].append(u.thinking)
            elif isinstance(u, ToolResultEntry) and u.tool_use_id:
                (self.mirrors if u.is_transport_mirror else self.canonical).add(u.tool_use_id)

    # ── primitives ──

    def _append(self, e: TranscriptEntry, track: bool) -> None:
        if track:
            self.pos[id(e)] = len(self.buf)
        self.buf.append(e)
        # Derivation runs on the folded entry, so a derived child inherits
        # whatever result has already been folded in (same as the full path).
        children = _derive_from(e, self.known)  # adds e.id + child ids to known
        self.buf.extend(children)
        self.derived.update(c.id for c in children)

    def _replace(self, old: TranscriptEntry, new: TranscriptEntry) -> None:
        """Swap a folded entry for its mutated copy and regenerate what
        derives from it (derived children copy the outcome at derive time)."""
        i = self.pos.pop(id(old))
        self.buf[i] = new
        self.pos[id(new)] = i
        # The derived chain sits right after its source, in layer order.
        j, chain = i + 1, {new.id}
        while j < len(self.buf) and self.buf[j].virtual and self.buf[j].derived_from in chain:
            chain.add(self.buf[j].id)
            j += 1
        if j == i + 1:
            return
        old_ids = [c.id for c in self.buf[i + 1 : j]]
        self.known.difference_update(old_ids)
        fresh = _derive_from(new, self.known)
        if [c.id for c in fresh] != old_ids:
            raise _NeedsFullRefold("derived children changed shape")
        self.buf[i + 1 : j] = fresh

    def feed(self, u: TranscriptEntry) -> None:
        """Fold one newly parsed (pristine) entry into ``buf``."""
        if u.id in self.derived:
            raise _NeedsFullRefold("physical id collides with a derived id")
        if isinstance(u, AssistantMessageEntry) and u.entry_id:
            grp = self.assistants.get(u.entry_id)
            if grp is None:
                self.assistants[u.entry_id] = [
                    u, [u.text] if u.text else [], [u.thinking] if u.thinking else [],
                ]
                self._append(u, True)
                return
            # A later row of a known message: join exactly as the full fold does.
            if u.text:
                grp[1].append(u.text)
            if u.thinking:
                grp[2].append(u.thinking)
            new = copy.copy(grp[0])
            new.text = "\n".join(grp[1]) if grp[1] else ""
            new.thinking = "\n".join(grp[2]) if grp[2] else None
            self._replace(grp[0], new)
            grp[0] = new
            return
        if isinstance(u, ToolResultEntry):
            tuid = u.tool_use_id
            if u.is_transport_mirror:
                if tuid in self.canonical:
                    return  # canonical already there: drop the mirror
                if tuid:
                    self.mirrors.add(tuid)
            elif tuid:
                if tuid in self.mirrors:
                    # The full fold would have dropped the mirror that is
                    # already in ``buf`` — only it can see both at once.
                    raise _NeedsFullRefold("canonical result after its transport mirror")
                self.canonical.add(tuid)
            target = self.calls.get(tuid) if tuid else None
            if target is None:
                if tuid:
                    self.loose.add(tuid)
                self._append(u, False)
                return
            new = copy.copy(target)
            _apply_tool_result(new, u)
            self._replace(target, new)
            self.calls[tuid] = new
            return
        tuid = getattr(u, "tool_use_id", None)
        if tuid and u.kind in _SEMANTIC_CALL_KINDS and tuid not in self.calls:
            if tuid in self.loose:
                # Its result is already standalone in ``buf``; the full fold
                # pairs them regardless of order.
                raise _NeedsFullRefold("call arrived after its result")
            self.calls[tuid] = u
            self._append(u, True)
            return
        self._append(u, False)


class AgentTranscriptFile:
    """Parsed view of a single agent's transcript JSONL file.

    Construction is eager: the file is read, every line dispatched through
    the worker-specific ``Parser``, and ``self.entries`` is populated.

    Also supports **incremental delta parsing** via ``parse_delta()`` —
    the same parser instance is fed new lines appended to the file since
    the previous call. The retained un-folded buffer keeps folding correct
    across delta boundaries. See ``TranscriptStreamer`` for the runtime
    that consumes this.
    """

    def __init__(
        self,
        worker_type: str,
        path: Path | str,
        *,
        session_id: str = "",
        transcript_format: TranscriptFormat | str | None = None,
    ) -> None:
        self.worker_type = worker_type
        self.path = Path(path)
        self.transcript_format = (
            TranscriptFormat(transcript_format) if transcript_format else None
        )
        parser_cls = get_parser_class(worker_type, self.transcript_format)
        self._parser = parser_cls(session_id=session_id)

        # ── delta state ──
        # Bytes already consumed from the file.
        self._byte_offset: int = 0
        # Monotonic line counter passed to parser.feed(raw, idx).
        self._line_idx: int = 0
        # Pre-fold retained list, kept pristine: a fold can reach back across
        # a delta boundary (a second row of an assistant message, a tool
        # result for an earlier call), and the entry it lands on is never
        # mutated in place but replaced by a copy — see ``_refold``.
        self._unfolded: list[TranscriptEntry] = []
        # Fold indexes kept between deltas (built lazily on the first delta,
        # so a one-shot parse pays nothing for them). ``None`` = next fold
        # is full. ``_folded_upto`` is how many of ``_unfolded`` are folded
        # into ``entries``; ``None`` until the first full fold.
        self._fold: _FoldState | None = None
        self._folded_upto: int | None = None
        # Cut index into folded ``self.entries`` for the delta API.
        self._last_emitted: int = 0
        self.entries: list[TranscriptEntry] = []

        # Initial read.
        self._read_and_fold()

    @property
    def session_id(self) -> str:
        """Session id, resolved from whichever line first carries one."""
        return self._parser.session_id

    # ── parsing ──────────────────────────────────────────────────────────────

    def _read_and_fold(self) -> list[TranscriptEntry]:
        """Read new bytes from ``_byte_offset`` to last newline, feed parser,
        append to ``_unfolded``, fold the new tail in, set ``self.entries``.

        Trailing incomplete line (no final ``\\n``) is buffered until the next
        call. Truncate/rewrite resets state and re-parses from offset 0.
        """
        if not self.path.exists():
            return self.entries

        # Whole-document workers (e.g. workflow run journals) are a single JSON
        # object, not JSONL — read the file once and feed the parsed object.
        if getattr(self._parser, "whole_document", False):
            return self._read_whole_document()

        try:
            file_size = self.path.stat().st_size
        except OSError as exc:
            logger.debug("AgentTranscriptFile: stat failed %s: %s", self.path, exc)
            return self.entries

        # Truncate / rewrite — file shrank. Reset everything.
        if file_size < self._byte_offset:
            self._reset_state()

        # One physical line at a time. The first read is the WHOLE file, and
        # slurping it meant holding the bytes, one decoded str (4 bytes per
        # char once any emoji is present) and a list of lines at once — a
        # transient peak of ~7x the file size. Iterating the buffered binary
        # file keeps nothing bigger than the longest line alive besides the
        # parsed entries. Binary iteration splits on b"\n" only, which is
        # exactly the boundary the partial-line rule needs.
        consumed = False
        try:
            with self.path.open("rb") as f:
                f.seek(self._byte_offset)
                for raw_bytes in f:
                    if not raw_bytes.endswith(b"\n"):
                        # Partial-line buffering: a trailing line with no
                        # final newline is deferred until the next call.
                        break
                    self._byte_offset += len(raw_bytes)
                    consumed = True
                    self._feed_line(raw_bytes)
        except OSError as exc:
            # Lines fed before the failure are already counted in
            # ``_byte_offset``; fall through so ``entries`` reflects them.
            logger.debug("AgentTranscriptFile: read failed %s: %s", self.path, exc)

        if not consumed:
            return self.entries

        # Fold the new entries in. Both fold passes write on the survivor
        # entry (assistant_messages joins `.text`/`.thinking`; tool_results
        # writes ``stdout_preview`` / ``content_preview`` / ``exit_code`` /
        # etc. on the call entry), so a fold target is always a shallow copy
        # and ``self._unfolded`` stays pristine across delta boundaries — an
        # earlier fold never feeds back into a later one.
        return self._refold()

    def _feed_line(self, raw_bytes: bytes) -> None:
        """Decode one complete physical line and feed its JSONL row(s) to the
        parser. ``splitlines()`` is kept on purpose: it is the line-boundary
        rule the whole-file decode used (it also splits on ``\\r``, U+2028,
        ...), so a row's ``_line_idx`` is unchanged by the line-at-a-time read.
        A multi-byte UTF-8 sequence never contains ``0x0A``, so decoding per
        physical line yields the same text as decoding the whole delta.
        """
        for raw_line in raw_bytes.decode("utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                logger.debug(
                    "AgentTranscriptFile: skipping malformed JSONL line %d in %s",
                    self._line_idx, self.path,
                )
                self._line_idx += 1
                continue
            self._unfolded.extend(self._parser.feed(raw, self._line_idx))
            self._line_idx += 1

    def _refold(self) -> list[TranscriptEntry]:
        """Fold ``self._unfolded`` into ``self.entries``.

        Incremental on a delta: only the entries parsed from the new lines are
        folded and derived, and an already-folded entry is touched only when a
        new line folds into it (replaced by a copy — ``_FoldState``). Cost per
        delta is O(new entries), not O(session). The full path runs for the
        first read, after a reset, for whole-document workers (their parser
        REPLACES ``_unfolded``) and for a write-order inversion the tail
        cannot resolve on its own — same algorithm, same output.
        """
        n = self._folded_upto
        if n is None or n > len(self._unfolded) or getattr(self._parser, "whole_document", False):
            return self._refold_full()
        if n == len(self._unfolded):
            return self.entries  # nothing new parsed
        if self._fold is None:  # lazily, on the first delta only
            self._fold = _FoldState(self._unfolded[:n], self.entries)
        try:
            for entry in self._unfolded[self._fold.n :]:
                self._fold.feed(entry)
        except _NeedsFullRefold as exc:
            logger.debug("AgentTranscriptFile: full refold of %s: %s", self.path, exc)
            return self._refold_full()
        self._fold.n = self._folded_upto = len(self._unfolded)
        # A new list per delta: a reader on the event loop keeps iterating
        # the snapshot it holds while the next delta is folded in a thread.
        self.entries = self._fold.buf[:]
        return self.entries

    def _refold_full(self) -> list[TranscriptEntry]:
        """Stock fold order over the whole retained list, copying only the
        entries a fold mutates (``_fold_targets``). Every other row is the
        SAME object as in ``_unfolded``, so a parser that amends an
        already-emitted row in place (Claude's keep-last usage dedup,
        ``parsers/claude.py``) stays visible in ``entries``.
        """
        self._fold = None
        targets = _fold_targets(self._unfolded)
        snapshot = [copy.copy(e) if id(e) in targets else e for e in self._unfolded]
        folded = self._fold_assistant_messages(snapshot)
        # Derivation runs LAST, after tool results have been folded in, so a
        # derived entry (e.g. FlowCommandEntry) inherits exit_code/stdout.
        self.entries = derive_entries(self._fold_tool_results(folded))
        self._folded_upto = len(self._unfolded)
        return self.entries

    def _read_whole_document(self) -> list[TranscriptEntry]:
        """Single-JSON-document path: read the entire file, parse it once, and
        feed the parsed object to the (whole-document) parser. Re-parses only when
        the file size changes since the last read (``_byte_offset`` doubles as the
        last-seen size sentinel here). Used for workflow run journals.
        """
        try:
            file_size = self.path.stat().st_size
        except OSError as exc:
            logger.debug("AgentTranscriptFile: stat failed %s: %s", self.path, exc)
            return self.entries
        if self.entries and file_size == self._byte_offset:
            return self.entries  # unchanged — idempotent
        try:
            text = self.path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            logger.debug("AgentTranscriptFile: read failed %s: %s", self.path, exc)
            return self.entries
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            logger.debug("AgentTranscriptFile: malformed JSON document %s", self.path)
            return self.entries
        self._unfolded = list(self._parser.feed(obj, 0))
        self._byte_offset = file_size
        return self._refold()

    def _reset_state(self) -> None:
        """Reset delta state + parser; preserves the resolved session_id so the
        parser doesn't lose it on truncate/rewrite. Used by truncate detection
        and ``force_reparse``."""
        session_id = self._parser.session_id
        parser_cls = get_parser_class(self.worker_type, self.transcript_format)
        self._parser = parser_cls(session_id=session_id)
        self._byte_offset = 0
        self._line_idx = 0
        self._unfolded = []
        self._fold = None
        self._folded_upto = None
        self._last_emitted = 0
        self.entries = []

    def parse_delta(self) -> list[TranscriptEntry]:
        """Read new bytes since the previous call and return only entries
        appended since the previous call.

        Idempotent within the same offset state — calling repeatedly without
        new file content returns []. After ``__init__``, the constructor's
        initial read counts as "unseen" until the first ``parse_delta`` call,
        which returns ALL entries. The streamer uses this to flush history
        to subscribers on first notification.
        """
        previous_count = self._last_emitted
        self._read_and_fold()
        new_only = self.entries[previous_count:]
        self._last_emitted = len(self.entries)
        return new_only

    def force_reparse(self) -> None:
        """Reset offset/state to 0 and re-read the full file. Next ``parse_delta``
        re-emits the entire history. Debug knob; used by ``streamer.force_reparse``.
        """
        self._reset_state()
        self._read_and_fold()

    @staticmethod
    def _fold_assistant_messages(
        entries: list[TranscriptEntry],
    ) -> list[TranscriptEntry]:
        """Merge same-entry_id AssistantMessageEntry rows (Claude writes one
        line per content block sharing the same message.id). Semantic tool
        entries keep their own row.
        """
        groups: dict[str, list[AssistantMessageEntry]] = {}
        for e in entries:
            if not isinstance(e, AssistantMessageEntry) or not e.entry_id:
                continue
            groups.setdefault(e.entry_id, []).append(e)

        if not any(len(g) > 1 for g in groups.values()):
            return entries

        dropped_ids: set[int] = set()
        for grp in groups.values():
            if len(grp) <= 1:
                continue
            survivor = grp[0]
            texts: list[str] = [survivor.text] if survivor.text else []
            thinkings: list[str] = [survivor.thinking] if survivor.thinking else []
            for extra in grp[1:]:
                if extra.text:
                    texts.append(extra.text)
                if extra.thinking:
                    thinkings.append(extra.thinking)
                dropped_ids.add(id(extra))
            survivor.text = "\n".join(texts) if texts else ""
            survivor.thinking = "\n".join(thinkings) if thinkings else None

        return [e for e in entries if id(e) not in dropped_ids]

    @staticmethod
    def _fold_tool_results(entries: list[TranscriptEntry]) -> list[TranscriptEntry]:
        """Fold ``ToolResultEntry`` payloads into the matching semantic call.

        Pairs by ``tool_use_id``. When a result matches a semantic kind
        (``shell_command``, ``file_read``, ``file_write``, ``file_edit``)
        the result is dropped from the timeline and its data folded into
        the call entry — yielding one row per agent operation.

        Catch-all ``ToolUseEntry`` results are left untouched so MCP /
        unknown tool flows keep rendering their result row separately
        (the renderer for those kinds doesn't know how to surface a
        folded result yet).
        """
        # Index semantic call entries by tool_use_id. Multiple call rows
        # can share an id (codex apply_patch with N file ops); fold into
        # the first one only — the rest carry no result data.
        call_index: dict[str, TranscriptEntry] = {}
        for e in entries:
            tuid = getattr(e, "tool_use_id", None)
            if not tuid:
                continue
            if e.kind not in _SEMANTIC_CALL_KINDS:
                continue
            if tuid in call_index:
                continue
            call_index[tuid] = e

        # Transport mirrors (codex ``event_msg.patch_apply_end``) duplicate a
        # canonical result under the same tool_use_id. Drop a mirror whenever
        # the canonical (non-mirror) result exists anywhere in the list — this
        # pass sees the whole retained list, so the pairing holds regardless
        # of write order (the incremental fold defers to it when the
        # canonical line lands after its mirror). A mirror whose canonical
        # line never arrived (turn killed between the two writes) survives
        # as the durable result frame.
        canonical_result_ids = {
            e.tool_use_id
            for e in entries
            if isinstance(e, ToolResultEntry) and e.tool_use_id and not e.is_transport_mirror
        }

        kept: list[TranscriptEntry] = []
        for e in entries:
            if not isinstance(e, ToolResultEntry):
                kept.append(e)
                continue
            if e.is_transport_mirror and e.tool_use_id in canonical_result_ids:
                continue
            target = call_index.get(e.tool_use_id) if e.tool_use_id else None
            if target is None:
                # Result belongs to a catch-all tool_use (or has no
                # paired call) — keep as standalone row.
                kept.append(e)
                continue
            _apply_tool_result(target, e)
        return kept

    # ── access ───────────────────────────────────────────────────────────────

    def __iter__(self) -> Iterator[TranscriptEntry]:
        return iter(self.entries)

    def __len__(self) -> int:
        return len(self.entries)

    def walk(self) -> Iterator[TranscriptEntry]:
        """Depth-first over top-level entries AND nested sub-agent children.

        Identical to flat iteration unless the transcript was assembled
        (:func:`flow_sdk.transcript_analyzer.assembly.assemble_tree`), which
        stitches each spawned sub-agent's entries onto
        ``AgentSpawnEntry.children``. A shared ``id()`` guard (in
        ``TranscriptEntry.walk``) makes a malformed cycle terminate.
        """
        seen: set[int] = set()
        for e in self.entries:
            yield from e.walk(seen)

    def filter(
        self,
        *,
        kind: EntryKind | None = None,
        tool_name: str | None = None,
    ) -> Iterator[TranscriptEntry]:
        """Yield entries matching all provided filters.

        ``tool_name`` matches any parsed entry that carries a tool name,
        including semantic operation entries such as ``shell_command``.
        Pass both filters together to combine — they're AND-ed.
        """
        for e in self.entries:
            if kind is not None and e.kind is not kind:
                continue
            if tool_name is not None:
                entry_tool_name = getattr(e, "tool_name", None)
                if entry_tool_name is None:
                    continue
                if entry_tool_name != tool_name:
                    continue
            yield e

    def latest_tool_use(self, tool_name: str) -> ToolUseEntry | None:
        """Return the most recent ``ToolUseEntry`` whose ``tool_name`` matches.

        Reverse-iterates ``entries`` so the first match wins. Returns the
        actual subclass instance (e.g. ``ExitPlanModeEntry`` for
        ``tool_name="ExitPlanMode"``) when applicable.
        """
        for e in reversed(self.entries):
            if isinstance(e, ToolUseEntry) and e.tool_name == tool_name:
                return e
        return None

    @property
    def prompts(self) -> list[UserMessageEntry]:
        """User-typed prompts in chronological order.

        Filters: drop sub-agent (``is_sidechain``) lines, drop empty/
        whitespace-only text, drop Claude Code's synthetic
        ``[Request interrupted by user for tool use]`` marker. Slash
        commands and Flowpad-injected prompts are kept — they're
        user-equivalent actions.
        """
        out: list[UserMessageEntry] = []
        for e in self.entries:
            if not isinstance(e, UserMessageEntry):
                continue
            if e.is_sidechain:
                continue
            text = (e.text or "").strip()
            if not text or text in _SYNTHETIC_USER_TEXTS:
                continue
            out.append(e)
        return out

    # ── cost / usage ─────────────────────────────────────────────────────────

    @property
    def usage(self) -> list[UsageEntry]:
        """Top-level (this file's) per-dim usage entries, in source order.

        Deliberately SHALLOW — it backs span attribution
        (:meth:`usage_in_span`) and per-lane cost, which must charge each lane
        only its own usage. For a whole-session total that includes stitched
        sub-agents, use :meth:`cost_deep` / :meth:`usage_deep`.

        Each entry represents one chargeable stream (tokens or requests)
        from a single assistant turn — see :class:`UsageEntry`. Pairing
        with :mod:`flow_sdk.transcript_analyzer.pricing` gives USD cost
        without losing per-stream detail (cache_read vs cache_write_1h
        vs server_tool_use are all separately matchable).
        """
        return [e for e in self.entries if isinstance(e, UsageEntry)]

    def usage_deep(self) -> list[UsageEntry]:
        """Usage entries across the whole assembled tree (incl. sub-agents).

        Each sub-agent file's usage was de-duplicated by its own parser
        (keep-last by message.id, per-file); we never re-dedup across files,
        so concatenating is correct and never double-counts.
        """
        return [e for e in self.walk() if isinstance(e, UsageEntry)]

    def _sum_cost(
        self,
        entries: Iterator[UsageEntry] | list[UsageEntry],
        pricing: dict[str, "ModelPricing"] | None,
    ) -> float:
        """Sum USD cost of ``entries``, resolving per-entry pricing by model."""
        from .pricing import pricing_for as _pricing_for

        total = 0.0
        for e in entries:
            table = pricing[e.model] if (pricing and e.model in pricing) else _pricing_for(e.model, self.worker_type)
            total += table.cost_of(e)
        return total

    def cost(self, pricing: dict[str, "ModelPricing"] | None = None) -> float:
        """Sum USD cost of this file's own usage (SHALLOW — no sub-agents).

        Mirrors :attr:`usage`; for the whole-session total use :meth:`cost_deep`.
        Per-entry pricing is resolved by ``entry.model``; the optional ``pricing``
        arg overrides the default lookup.
        """
        return self._sum_cost(self.usage, pricing)

    def cost_deep(self, pricing: dict[str, "ModelPricing"] | None = None) -> float:
        """Whole-session cost including every stitched sub-agent (see :meth:`usage_deep`)."""
        return self._sum_cost(self.usage_deep(), pricing)

    def usage_in_span(self, enter_ts: str, done_ts: str) -> list[UsageEntry]:
        """Usage entries whose ``timestamp`` falls in ``[enter_ts, done_ts]``.

        Mirrors the workflow-anchor pairing that ``session_analysis`` uses
        for tool_calls — so an analysis pass can attribute per-step cost
        the same way it already attributes per-step tool usage. Inclusive
        on both bounds; string compare works because Claude / Codex emit
        ISO-8601 timestamps with Z suffix.
        """
        return [e for e in self.usage if e.timestamp and enter_ts <= e.timestamp <= done_ts]

    def cost_in_span(
        self,
        enter_ts: str,
        done_ts: str,
        pricing: dict[str, "ModelPricing"] | None = None,
    ) -> float:
        """USD cost for usage entries within the time span. See :meth:`usage_in_span`."""
        return self._sum_cost(self.usage_in_span(enter_ts, done_ts), pricing)

    @property
    def latest_plan(self) -> ToolUseEntry | None:
        """Most recent ``ExitPlanModeEntry`` across workers, or None.

        Both Claude and Codex emit ``ExitPlanModeEntry`` (Codex synthesized
        from its ``<proposed_plan>`` marker by the Codex parser). The Codex
        TODO-checklist tool (``update_plan``) is intentionally NOT matched
        here — per Codex's own developer prompt it is unrelated to Plan Mode.

        Used by ``AgenticProcess._transcript_plan`` to drive the UI's
        "Open last plan" button uniformly across workers.
        """
        for entry in reversed(self.entries):
            if not isinstance(entry, ToolUseEntry):
                continue
            if entry.tool_name == "ExitPlanMode":
                return entry
        return None

    def to_flow_data(self) -> list["FlowData"]:
        """Concatenated ``FlowData`` stream from every entry."""
        return [fd for e in self.entries for fd in e.to_flow_data()]

    # ── string rendering ─────────────────────────────────────────────────────

    def to_string(self) -> str:
        """Human-readable rendering of every entry, in order.

        Header summarizes worker, session id, path, entry count, and any
        first-class fields surfaced from the leading ``session_meta`` line
        (codex: cwd, git, cli_version, originator, model_provider). Each
        entry is rendered via :meth:`TranscriptEntry.to_string` and joined
        by a blank line for skim-readability.
        """
        header_lines: list[str] = [
            f"# Transcript ({self.worker_type}) — {len(self.entries)} entries",
            f"# session_id: {self.session_id or '<unknown>'}",
            f"# path: {self.path}",
        ]
        meta = self._session_meta_payload()
        if meta:
            for label, key in (
                ("cwd", "cwd"),
                ("cli_version", "cli_version"),
                ("originator", "originator"),
                ("model_provider", "model_provider"),
            ):
                v = meta.get(key)
                if v:
                    header_lines.append(f"# {label}: {v}")
            git = meta.get("git") if isinstance(meta.get("git"), dict) else None
            if isinstance(git, dict):
                for label, key in (
                    ("git.branch", "branch"),
                    ("git.commit", "commit_hash"),
                    ("git.repo", "repository_url"),
                ):
                    v = git.get(key)
                    if v:
                        header_lines.append(f"# {label}: {v}")
        bodies = [e.to_string() for e in self.entries]
        return "\n\n".join(["\n".join(header_lines), *bodies])

    def _session_meta_payload(self) -> dict | None:
        """Locate the leading ``session_meta`` MetaEntry and return its payload.

        Returns ``None`` for transcripts that don't have one (claude
        rollouts, codex stream-event shape).
        """
        for e in self.entries[:5]:
            if isinstance(e, MetaEntry) and e.meta_kind == "session_meta":
                return e.payload
        return None

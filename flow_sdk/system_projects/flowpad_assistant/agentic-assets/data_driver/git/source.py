"""``GitSource`` — the committed files of a local git repository.

**It diffs; it never walks.** Every change comes from ``git diff``, the first traversal included —
it diffs against git's empty tree rather than listing the working directory, so an untracked
file is never reported and deletions and renames are exact instead of inferred. A rename comes
from the transport (``--find-renames``) as a move, so identity travels with the file.

**The cursor is one commit.** A traversal resumes at ``at:<sha>`` and diffs that commit to
``HEAD`` — complete, and cheap enough that a missed run costs nothing. The origin is
``(git, <repository root>, <repo-relative path>)``; the payload carries the blob id, which moves
exactly when the content does. It runs in-process: it reads this machine's own tree and holds
no credential.
"""
from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, AsyncGenerator, ClassVar, Optional

from pydantic import StringConstraints

from flow_sdk.sources.base import Altitude, Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import InvalidCursor, Rejected, SourceError, SourceUnavailable, Unsupported
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import FileData, FileItem
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage, Move
from flow_sdk.sources.values.query import DataQuery, ObjectQuery
from flow_sdk.sources.values.segment import SegmentRef

#: Git's empty tree: diffing against it yields everything committed, so the first traversal
#: needs no separate listing path and the never-walk rule holds on the very first run.
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
#: Git's own rename default, named because moving it changes which edits read as renames.
RENAME_SIMILARITY = "50%"
#: The ceiling one local git call ran under before this source existed. Not a retry budget.
GIT_TIMEOUT_SECONDS = 10

_AT = "at:"
_DIFF = "diff:"
_SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")


class GitFileData(FileData):
    """A committed file. ``blob`` is its content's id at the commit read."""

    spec_kind: ClassVar[str] = "ingest.file.git"

    blob: Optional[str] = None


@lru_cache(maxsize=64)
def _remote_url(repo: str) -> str:
    """A repository's remote, once per process: it is a property of the repository, not of a ref,
    and a subprocess per changed file made a 50-file commit pay 50 of them."""
    from flow_sdk.utils.git import git_remote_url  # noqa: PLC0415

    return git_remote_url(repo)


@dataclass(frozen=True)
class _Change:
    code: str
    path: str
    blob: str = ""
    previous: str = ""


class GitConfig(SourceConfig):
    """What a git source is configured with."""

    repo: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    branch: str = "HEAD"


class GitSource(Source):

    Config = GitConfig
    provider = "git"
    altitude = Altitude.IN_PROCESS
    reflects = True
    local_tree_key = "repo"
    durable_cursor = True
    page_size = MAX_PAGE_SIZE
    #: A tracked file is not ours to rewrite: the working tree stays byte-clean after an index pass.
    stamps_identity = False

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._diffs: dict[tuple[str, str], tuple[_Change, ...]] = {}

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def lift_cursor(cls, state: dict) -> Optional[str]:
        return cls.resume_at(state["sha"]) if state.get("sha") else None

    @classmethod
    def origin_id_for(cls, row: object, ref: str, root: object) -> str:
        """``GitOrigin.key()`` — the documented cross-machine handle, branch-independent, and computable
        for a path that no longer exists, so a deleted or renamed-from path still resolves to its row.
        No parseable remote: the generic path handle, never a second git-shaped key."""
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

        repo = Path(str(root))
        origin = GitOrigin.from_url(_remote_url(str(repo)), rel_path=Path(ref).resolve().relative_to(repo).as_posix())
        return str(origin.key()) if origin is not None else ""

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        """The repository root, canonical — the prefix every ref is relative to."""
        raw = str(binding.config.get("repo") or "")
        return os.path.realpath(os.path.expanduser(raw)) if raw else cls.provider

    @classmethod
    def resume_at(cls, sha: str) -> str:
        """The cursor that resumes after commit ``sha``."""
        return _AT + sha

    @property
    def repo(self) -> str:
        if not self.config.get("repo"):
            raise Rejected("config.repo is not set")
        return self._scope.namespace

    async def _close(self) -> None:
        self._diffs.clear()

    # ── listing ─────────────────────────────────────────────────────────────
    async def segments(self) -> list[SegmentRef]:
        """One per branch — never per directory, which a path can move between."""
        raw = str(self.config.get("repo") or "")
        if not raw:
            return []
        return [SegmentRef(key=str(self.config.get("branch") or "HEAD"), label=raw, query=ObjectQuery())]

    async def get(self, origin: CloudOrigin) -> Optional[FileItem]:
        self._require_open()
        key = self._scope.key(origin)
        listed = await self._git("ls-tree", "-z", "HEAD", "--", key)
        mode_type_blob, _, path = listed.partition("\0")[0].partition("\t")
        fields = mode_type_blob.split(" ")
        return self._item(key, fields[2]) if path == key and len(fields) == 3 and fields[1] == "blob" else None

    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and not isinstance(query, ObjectQuery):
            raise Unsupported(f"GitSource does not support {type(query).__name__}")
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        before, after, offset = await self._position(cursor)
        prefix = query.prefix if query is not None else ""
        changes = [c for c in await self._diff(before, after) if c.path.startswith(prefix) or c.previous.startswith(prefix or "\0")]
        page = changes[offset : offset + limit]
        items = tuple(self._item(c.path, c.blob) for c in page if c.code != "D")
        removed = tuple(self.origin(c.path) for c in page if c.code == "D")
        moved = tuple(Move(origin=self.origin(c.path), previous=self.origin(c.previous)) for c in page if c.code == "R")
        if offset + limit < len(changes):
            return ChangePage(items=items, removed=removed, moved=moved, next_cursor=f"{_DIFF}{before}:{after}:{offset + limit}")
        return ChangePage(items=items, removed=removed, moved=moved, resume_cursor=_AT + after)

    async def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncGenerator[FileItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(query, cursor=cursor, page_size=page_size)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    async def _position(self, cursor: Optional[str]) -> tuple[str, str, int]:
        """``(before, after, offset)`` for a cursor: a traversal from the beginning diffs the
        empty tree; ``at:<sha>`` diffs that commit to ``HEAD``; ``diff:`` continues a page chain."""
        if cursor is None:
            return EMPTY_TREE, await self._head(), 0
        if not isinstance(cursor, str):
            raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
        if cursor.startswith(_AT) and _SHA.fullmatch(cursor[len(_AT):]):
            return cursor[len(_AT):], await self._head(), 0
        before, _, rest = cursor.removeprefix(_DIFF).partition(":")
        after, _, offset = rest.partition(":")
        if cursor.startswith(_DIFF) and _SHA.fullmatch(before) and _SHA.fullmatch(after) and offset.isdigit():
            return before, after, int(offset)
        raise InvalidCursor("not a git cursor")

    async def _diff(self, before: str, after: str) -> tuple[_Change, ...]:
        """Every change between two commits, once per session however many pages read it."""
        if before == after:
            return ()
        if (before, after) not in self._diffs:
            raw = await self._git("diff", "--raw", "--no-abbrev", f"--find-renames={RENAME_SIMILARITY}", "-z", f"{before}..{after}")
            self._diffs[(before, after)] = tuple(_parse_raw_diff(raw))
        return self._diffs[(before, after)]

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        if not self.config.get("repo"):
            return Verdict(ready=False, detail="Set the repository to track.")
        if not os.path.exists(os.path.join(self.repo, ".git")):
            return Verdict(ready=False, detail=f"{self.repo} is not a git repository.")
        try:
            await self._head()
        except SourceError:
            return Verdict(ready=False, detail=f"{self.repo} has no commits yet.")
        return Verdict(ready=True)

    # ── the transport ───────────────────────────────────────────────────────
    async def _head(self) -> str:
        return (await self._git("rev-parse", "HEAD")).strip()

    async def _git(self, *args: str) -> str:
        repo = self.repo
        if not os.path.exists(os.path.join(repo, ".git")):
            # Needs a person, not a retry.
            raise Rejected(f"{repo} is not a git repository")
        return await self._blocking(_run_git, repo, args)

    def _item(self, path: str, blob: str) -> FileItem:
        return FileItem(origin=self.origin(path), data=GitFileData(name=path.rpartition("/")[2], path=path, blob=blob or None))


def _run_git(repo: str, args: tuple[str, ...]) -> str:
    try:
        result = subprocess.run(
            ["git", *args], cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="surrogateescape", timeout=GIT_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired as exc:
        raise SourceUnavailable(f"git {args[0]} did not finish within {GIT_TIMEOUT_SECONDS}s") from exc
    if result.returncode != 0:
        raise SourceUnavailable(f"git {args[0]} failed: {(result.stderr or '').strip()[:300]}")
    return result.stdout


def _parse_raw_diff(raw: str):
    """``git diff --raw -z`` records. A path may hold anything, newlines included, so records are
    NUL-separated, and a rename or copy spends two path fields — hence an iterator, which takes
    the extra field only when the status says there is one."""
    fields = iter(raw.split("\0"))
    for header in fields:
        if not header.startswith(":"):
            continue
        parts = header[1:].split(" ")
        if len(parts) < 5:
            return
        blob, code = parts[3], parts[4][:1]
        if code in ("R", "C"):
            previous, path = next(fields, ""), next(fields, "")
            if not path:
                return
            yield _Change("R" if code == "R" else "A", path, blob, previous if code == "R" else "")
            continue
        path = next(fields, "")
        if not path:
            return
        yield _Change("D" if code == "D" else "M", path, "" if code == "D" else blob)


__all__ = ["EMPTY_TREE", "RENAME_SIMILARITY", "GitFileData", "GitSource"]

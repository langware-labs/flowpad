"""Google Drive — the first source whose bytes are neither local nor a record.

Every driver before this one sat at one of two extremes. `rss`, `slack` and the
rest fetch *records* and hand them to `ingest_items`. `folder` and `git` deal in
*files* that were already on this machine, so Access cost nothing. Drive is the
first that must go and GET the bytes before anything local exists to index.

**So the cache directory IS this source's tree.** `fetch` downloads what
changed into `~/.flow/.../gdrive/<source-id>/` laid out along Drive's own folder
names, and returns those paths as `refs`. From there it is the folder driver's
story exactly: reflection places asset roots and `reindex_paths` types them. A
copying the cache into the project would duplicate
every byte for nothing — with `reflect: none` the cache is walked where it sits.

**Nothing is stamped into those files.** `stamps_identity = False`, for the same
reason a git working tree is not stamped: the next download overwrites the file
and takes the capsule with it, so identity would churn on every poll. Identity
comes from `origin_id`, and Drive gives the best one any source has — `fileId`
is assigned by Drive and survives rename, move, and content replacement. An
inode cannot promise the first two; a path cannot promise any of them.

**Delta is `changes.list`, and the page token is the whole cursor.** Drive keeps
a per-account change log, so a poll asks "what moved since this token" rather
than enumerating a drive. The first poll has no token, so it enumerates once via
`files.list` and then asks for a start token — the same
enumerate-once-then-diff shape `folder` uses, except Drive's diff is authoritative
rather than inferred, so a deletion here is observed rather than guessed.

**Read-only, deliberately.** The manifest asks for `drive.readonly`. A source
syncs *from* a system of record; writing back is `send`, and this driver has no
`send`.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

import httpx

from flow_sdk.capsules.atomic import atomic_write
from flow_sdk.ingest import http
from flow_sdk.ingest.driver import IngestDriver, FetchResult, SegmentCursorView, SegmentRef, SetupVerdict
from flow_sdk.ingest.health import SourceError

logger = logging.getLogger(__name__)

#: Drive's API roots. Module constants so a test can point them at a loopback
#: server, and `config.base_url` can override both for the same reason.
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"

#: The one scope this driver asks for. Named here as well as in the manifest
#: because `verify` reports it to the user, and a second spelling would let the
#: message drift from the consent screen.
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"

#: The single segment key. Same reasoning as the folder driver's: a Drive FOLDER
#: is a mutable grouping, and `segment_key` participates in `SourceItem`'s
#: natural key — keying on folders would fork a file's identity the moment
#: somebody dragged it somewhere else.
ROOT_SEGMENT = "root"

#: Files Drive stores as its own editor formats have no bytes to download; they
#: must be EXPORTED to something real. Mapping only the three that have an
#: obvious, lossless-enough text target — anything else is skipped rather than
#: guessed at, and skipping is reported.
EXPORT_TYPES = {
    "application/vnd.google-apps.document": ("text/markdown", ".md"),
    "application/vnd.google-apps.spreadsheet": ("text/csv", ".csv"),
    "application/vnd.google-apps.presentation": ("text/plain", ".txt"),
}

FOLDER_MIME = "application/vnd.google-apps.folder"

#: What every list call asks for. Explicit rather than `*`: Drive bills fields,
#: and a response that carries only what the driver reads cannot tempt a future
#: edit into depending on something the query does not request.
FILE_FIELDS = "id,name,mimeType,modifiedTime,size,parents,trashed"


def _safe_name(name: str) -> str:
    """A Drive name reduced to one path segment.

    Drive permits `/` and `..` in a file name; the local layout is built from
    those names, so a name that traversed would place bytes outside the cache.
    Reflection has its own traversal guard, but this driver is the one that
    KNOWS the name is provider-controlled, so it is sanitized where it enters.
    """
    cleaned = name.replace("/", "_").replace("\\", "_").strip()
    if cleaned in {"", ".", ".."}:
        return "_"
    return cleaned


class GoogleDriveDriver(IngestDriver):
    provider = "gdrive"
    kind = "datasource.fs.gdrive"

    #: The cache is OURS, and the next download overwrites it. A capsule stamped
    #: into one of these files survives exactly until the file changes upstream.
    stamps_identity = False

    def __init__(self) -> None:
        # Keyed by sidecar path, so one registered driver instance serves every
        # source without them sharing an entry. See `_read_index`.
        self._index_cache: dict[Path, tuple[int, int]] = {}
        self._index_by_path: dict[Path, dict[str, str]] = {}

    # ── addressing ────────────────────────────────────────────────────────

    def cache_root(self, source) -> Path:
        """Where this source's downloaded bytes live.

        Under the instance's own directory rather than the project: the bytes
        are a cache of a remote system, and deleting the source should be able
        to take them with it without touching anything the user wrote.
        """
        override = (source.config or {}).get("cache_root")
        if override:
            return Path(str(override)).expanduser().resolve()
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        return (get_instance_settings().instance_dir / "gdrive" / str(source.id)).resolve()

    def origin_for(self, source):
        """The cache, as the origin — a local tree whose bytes we refresh."""
        from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415

        return local_origin_for_path(self.cache_root(source))

    def index_path(self, source) -> Path:
        """The cache's `rel_path -> fileId` sidecar.

        On disk rather than in the cursor because `origin_id_for` is called by
        reflection, which is handed a ref and a source and never sees a cursor.
        The cursor still carries the same map — it is what the next delta diffs
        against — and `fetch` writes both from one dict, so they cannot drift.
        """
        return self.cache_root(source) / ".gdrive-index.json"

    def origin_id_for(self, source, ref: str) -> str:
        """Drive's own handle for the file, read out of the cache's sidecar.

        `fileId` rather than anything derived from the path: it is stable across
        rename, move and content replacement, which is why a cloud source can
        keep an asset's identity where a local folder source (holding only an
        inode) cannot.
        """
        root = self.cache_root(source)
        rel = str(Path(ref).resolve().relative_to(root))
        file_id = self._read_index(source).get(rel)
        if not file_id:
            raise KeyError(rel)  # caller falls back to the path
        return f"gdrive:{file_id}"

    def _read_index(self, source) -> dict[str, str]:
        """The sidecar, cached on its own (mtime, size).

        Reflection asks for an origin TWICE per ref, and the sidecar holds every
        file the source has ever seen — so re-reading and re-parsing it per call
        is quadratic in the size of the drive. `_write_index` replaces the file
        atomically, so the stat pair moves whenever the contents do and the
        cache cannot go stale.
        """
        path = self.index_path(source)
        try:
            st = path.stat()
        except OSError:
            return {}
        stamp = (st.st_mtime_ns, st.st_size)
        if self._index_cache.get(path) == stamp:
            return self._index_by_path[path]
        try:
            loaded = dict(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return {}
        self._index_cache[path] = stamp
        self._index_by_path[path] = loaded
        return loaded

    def _write_index(self, source, index: dict[str, str]) -> None:
        atomic_write(self.index_path(source), json.dumps(index, indent=2).encode("utf-8"))

    async def segments(self, source) -> list[SegmentRef]:
        """One segment per configured drive, defaulting to the user's own.

        A shared drive is a genuinely separate change log — `changes.list` takes
        a `driveId` — so it earns a segment and its own cursor. Nothing else in
        Drive does.
        """
        drives = [str(d).strip() for d in ((source.config or {}).get("drives") or []) if str(d).strip()]
        if not drives:
            return [SegmentRef(key=ROOT_SEGMENT, label="My Drive")]
        return [SegmentRef(key=d, label=d) for d in drives]

    # ── setup ─────────────────────────────────────────────────────────────

    async def verify(self, source) -> SetupVerdict:
        """Is there a Google credential on this machine that can read Drive?

        The only setup question Drive has. Everything else about the source is
        config, and config that is wrong shows up as a config error on the first
        poll rather than as an unfinished setup.
        """
        token = await self._token(source)
        if not token:
            return SetupVerdict.waiting(
                "No Google credential on this machine. Connect Google, then verify the source."
            )
        try:
            async with http.client() as client:
                await self._call(client, source, token, "/about", {"fields": "user(emailAddress)"})
        except SourceError as exc:
            return SetupVerdict.waiting(
                f"Google refused the stored credential ({exc}). Reconnect Google, "
                f"granting {DRIVE_SCOPE}."
            )
        return SetupVerdict.ok()

    # ── the sync ──────────────────────────────────────────────────────────

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        token = await self._token(source)
        if not token:
            raise SourceError.config(
                "no_credential",
                "No Google credential on this machine. Connect Google, then verify the source.",
            )

        state = dict(cursor.state or {})
        page_token = state.get("page_token")
        root = self.cache_root(source)
        index = dict(state.get("index") or {})
        refs: list[str] = []
        skipped = 0

        # ONE client for the whole poll. A first pass over a large drive is
        # hundreds of requests, and a client per request pays a fresh TCP+TLS
        # handshake for each — `hackernews` and `rss` already thread one client
        # through a fetch for exactly this reason.
        async with http.client() as client:
            if page_token:
                changed, removed, next_token = await self._delta(
                    client, source, token, cursor.segment_key, page_token
                )
            else:
                changed, removed, next_token = await self._first_pass(
                    client, source, token, cursor.segment_key
                )

            # The layout is flat (`_safe_name` collapses separators), so the
            # destination directory is loop-invariant.
            root.mkdir(parents=True, exist_ok=True)
            for meta in changed:
                placed = await self._download(client, source, token, meta, root)
                if placed is None:
                    skipped += 1
                    continue
                refs.append(str(placed))
                index[str(placed.relative_to(root))] = meta["id"]

        # A removal is OBSERVED here — Drive says a file was trashed or deleted,
        # it is not inferred from absence. That is what lets this driver fill
        # `tombstones` at all; a source that only knows "I did not see it" must
        # never write here (the rule `rss.py` states as "absence is never
        # deletion").
        tombstones: list[str] = []
        by_id = {file_id: rel for rel, file_id in index.items()}
        for file_id in removed:
            rel = by_id.get(file_id)
            if not rel:
                continue
            tombstones.append(str(root / rel))
            index.pop(rel, None)

        # One dict, written to both homes: the cursor (what the next delta
        # diffs) and the sidecar (what `origin_id_for` reads).
        if skipped:
            # Never a silent drop: a Drive Form or a shortcut has no bytes, and
            # a source that quietly ingested 40 of 45 files reads as complete.
            logger.info(
                "[gdrive] %s: skipped %d item(s) with no downloadable bytes", source.id, skipped
            )
        self._write_index(source, index)

        return FetchResult(
            refs=refs,
            tombstones=tombstones,
            next_state={"page_token": next_token, "index": index},
            # Deliberately no `high_water`: `sync.py` folds it into `was_clean`,
            # so any value at all writes the cursor row on every tick — the
            # once-per-feed-per-minute floor that design exists to avoid. The
            # file count is observable from the sidecar.
            unchanged=not refs and not tombstones,
        )

    # ── Drive's two list calls ────────────────────────────────────────────

    async def _first_pass(self, client, source, token: str, segment: str):
        """Enumerate once, then ask Drive where the change log starts.

        The start token is taken AFTER the enumeration, never before: a file
        created while the pages were being walked is then reported by the first
        delta instead of falling into the gap between the two calls.
        """
        files = await self._list_files(client, source, token, segment)
        start = await self._call(client, source, token, "/changes/startPageToken", self._drive_params(segment))
        return files, [], str(start.get("startPageToken") or "")

    async def _list_files(self, client, source, token: str, segment: str) -> list[dict]:
        out: list[dict] = []
        params = {
            "q": "trashed = false",
            "fields": f"nextPageToken,files({FILE_FIELDS})",
            "pageSize": "100",
            **self._drive_params(segment),
        }
        page: Optional[str] = None
        while True:
            if page:
                params["pageToken"] = page
            body = await self._call(client, source, token, "/files", params)
            out.extend(f for f in (body.get("files") or []) if f.get("mimeType") != FOLDER_MIME)
            page = body.get("nextPageToken")
            if not page:
                return out

    async def _delta(self, client, source, token: str, segment: str, page_token: str):
        """What moved since `page_token`.

        Drive's change log is authoritative about deletion, which is the whole
        reason this is not an enumerate-and-diff. It reports a file that was
        trashed as well as one that was removed outright; both mean "no longer
        ours to index", so both become tombstones.
        """
        changed: list[dict] = []
        removed: list[str] = []
        params = {
            "pageToken": page_token,
            "fields": f"nextPageToken,newStartPageToken,changes(fileId,removed,file({FILE_FIELDS}))",
            "pageSize": "100",
            **self._drive_params(segment),
        }
        while True:
            body = await self._call(client, source, token, "/changes", params)
            for change in body.get("changes") or []:
                meta = change.get("file") or {}
                if change.get("removed") or meta.get("trashed"):
                    removed.append(str(change.get("fileId") or meta.get("id") or ""))
                elif meta.get("mimeType") != FOLDER_MIME and meta.get("id"):
                    changed.append(meta)
            nxt = body.get("nextPageToken")
            if not nxt:
                return changed, [r for r in removed if r], str(body.get("newStartPageToken") or page_token)
            params["pageToken"] = nxt

    @staticmethod
    def _drive_params(segment: str) -> dict[str, str]:
        """The shared-drive half of every call, or nothing for My Drive."""
        if not segment or segment == ROOT_SEGMENT:
            return {}
        return {
            "driveId": segment,
            "corpora": "drive",
            "includeItemsFromAllDrives": "true",
            "supportsAllDrives": "true",
        }

    # ── bytes ─────────────────────────────────────────────────────────────

    async def _download(self, client, source, token: str, meta: dict, root: Path) -> Optional[Path]:
        """One file into the cache. `None` when Drive has no bytes to give.

        A Google-native document is not a file — it is a document Drive renders
        on request — so it is EXPORTED to a real format or skipped. Skipping is
        the honest answer for a Drive Form or a shortcut: inventing an empty
        file for it would put an asset in the graph that stands for nothing.
        """
        native = str(meta.get("mimeType") or "")
        name = _safe_name(str(meta.get("name") or meta.get("id") or "file"))
        if native.startswith("application/vnd.google-apps."):
            export = EXPORT_TYPES.get(native)
            if export is None:
                logger.debug("[gdrive] skipping %s (%s): no export target", name, native)
                return None
            mime, suffix = export
            path_params = {"mimeType": mime}
            endpoint = f"/files/{meta['id']}/export"
            if not name.endswith(suffix):
                name = f"{name}{suffix}"
        else:
            path_params = {"alt": "media"}
            endpoint = f"/files/{meta['id']}"

        dest = root / name
        content = await self._get(client, source, token, endpoint, path_params)
        # Atomic: a poll that dies mid-download must not leave a half file that
        # the indexer then types as the real asset. `atomic_write` also cleans
        # its temp file up on failure, which a hand-rolled rename does not.
        atomic_write(dest, content)
        return dest

    # ── transport ─────────────────────────────────────────────────────────

    def _base(self, source) -> str:
        return str((source.config or {}).get("base_url") or DRIVE_API_BASE).rstrip("/")

    async def _get(self, client, source, token: str, path: str, params: dict) -> bytes:
        """One authenticated GET through the house transport.

        `http.get` owns the request ceiling, turns a transport failure into a
        classified error, and maps the status through `SourceError.for_status` —
        THE status→health table. A second table here is how Drive would miss the
        next rule added to it, and it had already drifted: this driver read 429
        as a generic `http_429` where the canonical table calls it
        `rate_limited`.
        """
        url = httpx.URL(f"{self._base(source)}{path}").copy_merge_params(params)
        response = await http.get(client, str(url), headers={"Authorization": f"Bearer {token}"})
        return response.content

    async def _call(self, client, source, token: str, path: str, params: dict) -> dict[str, Any]:
        raw = await self._get(client, source, token, path, params)
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise SourceError.transient("bad_json", str(exc)) from exc

    async def _token(self, source) -> Optional[str]:
        """This machine's Google token. The precedence lives in one place."""
        from flow_sdk.core.oauth.provider_registry import GOOGLE, token_for  # noqa: PLC0415

        return await token_for(GOOGLE)

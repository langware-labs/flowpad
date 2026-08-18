"""Google Drive — the first source whose bytes are neither local nor a record.

Every driver before this one sat at one of two extremes. `rss`, `slack` and the
rest fetch *records* and hand them to `ingest_items`. `folder` and `git` deal in
*files* that were already on this machine, so Access cost nothing. Drive is the
first that must go and GET the bytes before anything local exists to index.

**So the cache directory IS this source's tree.** `fetch` downloads what
changed into `~/.flow/.../gdrive/<source-id>/` laid out along Drive's own folder
names, and returns those paths as `refs`. From there it is the folder driver's
story exactly: reflection places asset roots and `reindex_paths` types them. A
`materialize` mode that re-copied the cache into the project would duplicate
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
import os
from pathlib import Path
from typing import Any, Optional

from flow_sdk.ingest.driver import FetchResult, SegmentCursorView, SegmentRef, SetupVerdict
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


class GoogleDriveDriver:
    provider = "gdrive"
    kind = "datasource.fs.gdrive"
    #: Declared for protocol symmetry. Like `folder`, this driver never produces
    #: an IngestItem — its payload lands as files.
    record_kind = ""

    #: The cache is OURS, and the next download overwrites it. A capsule stamped
    #: into one of these files survives exactly until the file changes upstream.
    stamps_identity = False

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

    #: Reflection asks the driver where its tree begins — see `reflect.source_root`.
    source_root = cache_root

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
        rel = str(Path(ref).resolve().relative_to(self.cache_root(source)))
        file_id = self._read_index(source).get(rel)
        if not file_id:
            raise KeyError(rel)  # caller falls back to the path
        return f"gdrive:{file_id}"

    def _read_index(self, source) -> dict[str, str]:
        try:
            return dict(json.loads(self.index_path(source).read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return {}

    def _write_index(self, source, index: dict[str, str]) -> None:
        path = self.index_path(source)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.part")
        tmp.write_text(json.dumps(index, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def segments(self, source) -> list[SegmentRef]:
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
            await self._call(source, token, "/about", {"fields": "user(emailAddress)"})
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
        if page_token:
            changed, removed, next_token = await self._delta(source, token, cursor.segment_key, page_token)
        else:
            changed, removed, next_token = await self._first_pass(source, token, cursor.segment_key)

        root = self.cache_root(source)
        index = dict(state.get("index") or {})

        refs: list[str] = []
        skipped = 0
        for meta in changed:
            placed = await self._download(source, token, meta, root)
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
            high_water=str(len(index)),
            unchanged=not refs and not tombstones,
        )

    # ── Drive's two list calls ────────────────────────────────────────────

    async def _first_pass(self, source, token: str, segment: str):
        """Enumerate once, then ask Drive where the change log starts.

        The start token is taken AFTER the enumeration, never before: a file
        created while the pages were being walked is then reported by the first
        delta instead of falling into the gap between the two calls.
        """
        files = await self._list_files(source, token, segment)
        start = await self._call(source, token, "/changes/startPageToken", self._drive_params(segment))
        return files, [], str(start.get("startPageToken") or "")

    async def _list_files(self, source, token: str, segment: str) -> list[dict]:
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
            body = await self._call(source, token, "/files", params)
            out.extend(f for f in (body.get("files") or []) if f.get("mimeType") != FOLDER_MIME)
            page = body.get("nextPageToken")
            if not page:
                return out

    async def _delta(self, source, token: str, segment: str, page_token: str):
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
            body = await self._call(source, token, "/changes", params)
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

    async def _download(self, source, token: str, meta: dict, root: Path) -> Optional[Path]:
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
        dest.parent.mkdir(parents=True, exist_ok=True)
        content = await self._get(source, token, endpoint, path_params)
        # Write through a temp file in the same directory and rename over: a
        # poll that dies mid-download must not leave a half file that the
        # indexer then types as the real asset.
        tmp = dest.with_name(f".{dest.name}.part")
        tmp.write_bytes(content)
        os.replace(tmp, dest)
        return dest

    # ── transport ─────────────────────────────────────────────────────────

    def _base(self, source) -> str:
        return str((source.config or {}).get("base_url") or DRIVE_API_BASE).rstrip("/")

    async def _get(self, source, token: str, path: str, params: dict) -> bytes:
        """One authenticated GET. Metadata and bytes differ only in how the
        caller reads the body, so the request itself is written once."""
        import httpx  # noqa: PLC0415

        from flow_sdk.ingest.http import REQUEST_TIMEOUT_SECONDS  # noqa: PLC0415

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(
                    f"{self._base(source)}{path}",
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                )
        except httpx.HTTPError as exc:
            raise SourceError.transient("network_error", str(exc)) from exc

        self._raise_for_status(response.status_code, response.text)
        return response.content

    async def _call(self, source, token: str, path: str, params: dict) -> dict[str, Any]:
        raw = await self._get(source, token, path, params)
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise SourceError.transient("bad_json", str(exc)) from exc

    @staticmethod
    def _raise_for_status(status: int, detail: str) -> None:
        """Drive's status codes, split the way health cares about them.

        401/403 need a person (reconnect, or grant the scope) and must park the
        source; 429 and 5xx are the provider having a moment and must not. The
        split is the difference between a source that recovers on its own and
        one that stays broken until somebody notices.
        """
        if status in (401, 403):
            raise SourceError.config("credential_refused", detail[:400] or f"HTTP {status}")
        if status == 404:
            raise SourceError.config("not_found", detail[:400] or "HTTP 404")
        if status >= 400:
            raise SourceError.transient(f"http_{status}", detail[:400] or f"HTTP {status}")

    async def _token(self, source) -> Optional[str]:
        """The Google token, wherever it ended up.

        Local SOD first, then the hub — the same order and the same reason as
        `SlackDriver._token`: connection sharing copies a hub token down, so on
        a set-up machine it is already local, and the hub covers the window
        before a desktop has adopted it.
        """
        from flow_sdk.core.oauth.provider_probe import token_from_credential  # noqa: PLC0415
        from flow_sdk.core.oauth.provider_registry import GOOGLE, user_credentials_name  # noqa: PLC0415

        name = user_credentials_name(GOOGLE)
        try:
            from flow_sdk.builtin.user import User  # noqa: PLC0415
            from flow_sdk.request_context.methods import get_user_credentials  # noqa: PLC0415

            user = await User.get_local()
            if user is not None and name:
                token = token_from_credential(await get_user_credentials(user, name, user.id))
                if token:
                    return token
        except Exception:  # noqa: BLE001 — absence is the normal case, not an error
            logger.debug("gdrive: no local credential", exc_info=True)

        try:
            from flow_sdk.core.oauth.hub_oauth import (  # noqa: PLC0415
                hub_credential_value,
                hub_credentials_name_for,
            )

            return token_from_credential(await hub_credential_value(hub_credentials_name_for(GOOGLE)))
        except Exception:  # noqa: BLE001
            logger.debug("gdrive: no hub credential", exc_info=True)
            return None

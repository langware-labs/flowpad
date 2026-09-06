"""Google Cloud Storage — a bucket as a source of files.

The third shape of remote-bytes source, and it sits between the two that exist.
Like `gdrive` it must GET the bytes before anything local exists to index, so the cache
directory IS this source's tree and `reflect` decides whether that tree is walked where it
sits or copied into a project. Like `folder` it has no change log: GCS answers "what is in
this bucket now", so a poll is an ENUMERATE-AND-DIFF against the last listing, not a delta.

**A deletion is still observed, not guessed.** The listing is complete and authoritative for
the prefix it covers — an object that was there and is not now is gone, which is a stronger
statement than a feed's silence. So this driver may fill `tombstones`, and the rule `rss.py`
states ("absence is never deletion") does not bite here: absence from an authoritative
enumeration IS deletion.

**A rename is never observed.** GCS has no move: a "rename" is a copy under a new name and a
delete of the old one, and the API reports exactly that. So `renames` stays empty and the
pair arrives as one tombstone and one new ref — the honest reading of what happened.

**Identity is `gs://bucket/object`.** No sidecar, unlike Drive: an object's name IS its path,
so the handle falls out of the cached file's location. It survives content replacement (a new
`generation`, same name), which is what a local folder source's inode cannot promise.

**Read-only, deliberately.** The scope asked for is `devstorage.read_only`; writing back is
`send`, and this driver has none.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from flow_sdk.capsules.atomic import atomic_write
from flow_sdk.ingest import http
from flow_sdk.ingest.driver import FetchResult, IngestDriver, SegmentCursorView, SegmentRef, SetupVerdict
from flow_sdk.ingest.health import SourceError
from flow_sdk.schema.data_spec.choice_spec import Choice

logger = logging.getLogger(__name__)

#: The JSON API root. A module constant so a test can point it at a loopback server, and so
#: `config.base_url` can override it for the same reason.
GCS_API_BASE = "https://storage.googleapis.com/storage/v1"

#: The one scope this driver asks for. Named here as well as in the manifest because `verify`
#: reports it to the user, and a second spelling would let the message drift from the consent
#: screen.
GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only"

#: How many objects are downloaded at once. A first poll of a large bucket is one GET per
#: object and strictly sequential that is minutes of wall clock; a small gate is still an
#: order of magnitude. Deliberately small rather than unbounded: `_download` holds a whole
#: object in memory, so the gate bounds peak RSS as much as it bounds sockets.
GCS_DOWNLOAD_CONCURRENCY = 4

#: The segment key when no prefix is configured — the whole bucket.
ROOT_SEGMENT = "/"

#: What a listing asks for. Explicit rather than `*`: a response carrying only what the driver
#: reads cannot tempt a later edit into depending on something the query never requested.
OBJECT_FIELDS = "nextPageToken,items(name,generation,size,updated,contentType)"


def _safe_rel(name: str) -> Optional[str]:
    """An object name as a relative local path, or ``None`` if it cannot be one.

    Object names are provider-controlled and may contain anything, including ``..`` segments
    and a leading ``/``. Reflection has its own traversal guard, but this driver is the one
    that KNOWS the name is remote input, so it is sanitized where it enters. A name that is
    only separators, or that escapes, is refused rather than coerced into a guess.
    """
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(p.replace("\\", "_") for p in parts)


class GoogleCloudStorageDriver(IngestDriver):
    provider = "gcs"
    #: Read with the machine's Google connection — the credential is machine-level, not a
    #: field on the row, so `verify` can fail with the fix in the message before any poll.
    connection = "google"
    kind = "datasource.fs.gcs"
    #: The config field naming WHICH remote account this source serves.
    identity_config_key = "bucket"

    #: The cache is OURS and the next download overwrites it. A capsule stamped into one of
    #: these files survives exactly until the object changes upstream, so identity comes from
    #: `origin_id_for` instead.
    stamps_identity = False

    # ── addressing ────────────────────────────────────────────────────────

    def bucket(self, source) -> str:
        name = str((source.config or {}).get("bucket") or "").strip().removeprefix("gs://").strip("/")
        if not name:
            raise SourceError.config("no_bucket", "config.bucket is not set")
        return name

    def _bucket_path(self, source, suffix: str = "") -> str:
        """``/b/<bucket><suffix>`` — one place that remembers ``safe=''``.

        A bucket name is user input and a slash in it must not become a path separator, so the
        escaping cannot be optional at any one call site.
        """
        return f"/b/{quote(self.bucket(source), safe='')}{suffix}"

    def cache_root(self, source) -> Path:
        """Where this source's downloaded bytes live.

        Under the instance's own directory rather than a project: the bytes are a cache of a
        remote system, and deleting the source should be able to take them with it without
        touching anything the user wrote.
        """
        override = (source.config or {}).get("cache_root")
        if override:
            return Path(str(override)).expanduser().resolve()
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        return (get_instance_settings().instance_dir / "gcs" / str(source.id)).resolve()

    def origin_for(self, source):
        """The cache, as the origin — a local tree whose bytes we refresh."""
        from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415

        return local_origin_for_path(self.cache_root(source))

    def origin_id_for(self, source, ref: str) -> str:
        """``gcs:<bucket>/<object>`` — derived from the path, with no sidecar.

        Unlike Drive, whose `fileId` is unrelated to a file's name, a GCS object's NAME is its
        identity and the cache mirrors it exactly. So the handle is computable from the ref,
        which removes a whole file of bookkeeping and the ways it can drift from the cursor.
        """
        rel = Path(ref).resolve().relative_to(self.cache_root(source))
        return f"gcs:{self.bucket(source)}/{rel.as_posix()}"

    async def segments(self, source) -> list[SegmentRef]:
        """One segment per configured prefix, defaulting to the whole bucket.

        A prefix is a stable grouping the operator chose — unlike a Drive folder, which is a
        mutable thing a file can be dragged out of. GCS has no directories at all; a prefix is
        a query, so keying on one cannot fork an object's identity.
        """
        prefixes = [str(p).strip() for p in ((source.config or {}).get("prefixes") or []) if str(p).strip()]
        if not prefixes:
            return [SegmentRef(key=ROOT_SEGMENT, label=self.bucket(source))]
        return [SegmentRef(key=p, label=p) for p in prefixes]

    # ── setup ─────────────────────────────────────────────────────────────

    async def verify(self, source) -> SetupVerdict:
        """Is there a Google credential on this machine that can read this bucket?

        The only setup question GCS has. Everything else is config, and config that is wrong
        shows up as a config error on the first poll rather than as unfinished setup.
        """
        token = await self._token(source)
        if not token:
            return SetupVerdict.waiting("No Google credential on this machine. Connect Google, then verify the source.")
        try:
            async with http.client() as client:
                await self._call(client, source, token, self._bucket_path(source), {"fields": "name"})
        except SourceError as exc:
            return SetupVerdict.waiting(
                f"Google refused the stored credential for this bucket ({exc}). "
                f"Reconnect Google, granting {GCS_SCOPE}, and check the bucket name."
            )
        return SetupVerdict.ok()

    async def choices(self, source, field: str) -> list[Choice]:
        """The buckets this credential can see — the `bucket` field's offer.

        Read ONLY here. `config.project` exists for this call and nothing else: `fetch`
        and `verify` work from a bucket name the user already gave, and making them
        depend on a project id would break every source configured before this existed.

        The project is checked before any round trip, because "I cannot list without one"
        is a cheaper and more useful answer than a 400 from Google.
        """
        if field != "bucket":
            return []
        project = str((source.config or {}).get("project") or "").strip()
        if not project:
            raise SourceError.config(
                "no_project", "Set 'GCP project' to list buckets, or type the bucket name."
            )
        token = await self._token(source)
        if not token:
            raise SourceError.config(
                "no_credential", "No Google credential on this machine. Connect Google first."
            )
        async with http.client() as client:
            body = await self._call(
                client, source, token, "/b", {"project": project, "fields": "items(name,location)"}
            )
        # A bucket's name IS its id, so `name` repeats it deliberately — the form collapses
        # that pair back to a plain string rather than storing a dict for no gain.
        return [
            Choice(id=str(b["name"]), name=str(b["name"]), detail=str(b.get("location") or "").lower())
            for b in body.get("items") or []
            if b.get("name")
        ]

    # ── the sync ──────────────────────────────────────────────────────────

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        token = await self._token(source)
        if not token:
            raise SourceError.config(
                "no_credential",
                "No Google credential on this machine. Connect Google, then verify the source.",
            )

        previous: dict[str, str] = cursor.state or {}
        root = self.cache_root(source)
        refs: list[str] = []
        skipped = 0

        # ONE client for the whole poll. A first pass over a large bucket is hundreds of
        # requests, and a client per request pays a fresh TCP+TLS handshake for each.
        async with http.client() as client:
            listing = await self._list_objects(client, source, token, cursor.segment_key)

            root.mkdir(parents=True, exist_ok=True)
            current: dict[str, str] = {}
            # Two passes: the whole diff is decided before any byte is fetched, so the
            # downloads can run against each other under the gate below.
            stale: list[tuple[str, str]] = []
            for meta in listing:
                name = str(meta.get("name") or "")
                rel = _safe_rel(name)
                if rel is None or name.endswith("/"):
                    # A zero-byte "directory placeholder" is not a document, and a name that
                    # cannot be a path is refused rather than guessed at. Both are counted.
                    skipped += 1
                    continue
                generation = str(meta.get("generation") or "")
                current[rel] = generation
                if previous.get(rel) != generation:
                    stale.append((rel, name))

            gate = asyncio.Semaphore(GCS_DOWNLOAD_CONCURRENCY)

            async def _fetch(rel: str, name: str) -> str:
                async with gate:
                    return str(await self._download(client, source, token, name, rel, root))

            refs = list(await asyncio.gather(*(_fetch(rel, name) for rel, name in stale)))

        # Absence from an authoritative enumeration IS deletion — see the module docstring.
        tombstones = [str(root / rel) for rel in previous if rel not in current]

        if skipped:
            # Never a silent drop: a source that quietly ingested 40 of 45 objects reads as
            # complete.
            logger.info("[gcs] %s: skipped %d object(s) with no usable path", source.id, skipped)

        return FetchResult(
            refs=refs,
            # GCS reports no move, so a rename arrives as a tombstone and a new ref, and
            # `renames` stays unfilled: guessing at a pair would make identity travel to the
            # wrong object.
            tombstones=tombstones,
            next_state=current,
            # Deliberately no `high_water`: `sync.py` folds it into `was_clean`, so any value
            # writes the cursor row every tick — the floor that design exists to avoid.
            unchanged=not refs and not tombstones,
        )

    # ── the one list call ─────────────────────────────────────────────────

    async def _list_objects(self, client, source, token: str, segment: str) -> list[dict]:
        """Every object under this segment's prefix, following pagination.

        One call shape, because GCS has no change log: the listing IS the state. That makes a
        poll O(objects) rather than O(changes) — the same trade the local folder driver makes,
        and the reason `prefixes` exists to bound it.
        """
        params: dict[str, str] = {"fields": OBJECT_FIELDS, "maxResults": "1000"}
        if segment and segment != ROOT_SEGMENT:
            params["prefix"] = segment
        out: list[dict] = []
        page: Optional[str] = None
        while True:
            if page:
                params["pageToken"] = page
            body = await self._call(client, source, token, self._bucket_path(source, "/o"), params)
            out.extend(body.get("items") or [])
            page = body.get("nextPageToken")
            if not page:
                return out

    # ── bytes ─────────────────────────────────────────────────────────────

    async def _download(self, client, source, token: str, name: str, rel: str, root: Path) -> Path:
        """One object into the cache, at the path its name describes."""
        dest = root / rel
        content = await self._get(
            client, source, token,
            self._bucket_path(source, f"/o/{quote(name, safe='')}"),
            {"alt": "media"},
        )
        # Atomic: a poll that dies mid-download must not leave a half file for the indexer to
        # type as the real asset. `atomic_write` also cleans its temp file up on failure.
        atomic_write(dest, content)
        return dest

    # ── transport ─────────────────────────────────────────────────────────

    def _base(self, source) -> str:
        return str((source.config or {}).get("base_url") or GCS_API_BASE).rstrip("/")

    async def _get(self, client, source, token: str, path: str, params: dict) -> bytes:
        """One authenticated GET through the house transport — which owns the request ceiling
        and maps the status through `SourceError.for_status`, THE status→health table."""
        response = await http.get(
            client, f"{self._base(source)}{path}", params=params, headers=self._auth(token)
        )
        return response.content

    async def _call(self, client, source, token: str, path: str, params: dict) -> dict[str, Any]:
        """The same GET, decoded by the house transport."""
        return await http.request_json(
            client, "GET", f"{self._base(source)}{path}", params=params, headers=self._auth(token)
        )

    @staticmethod
    def _auth(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    async def _token(self, source) -> Optional[str]:
        """This machine's Google token. The precedence lives in one place."""
        from flow_sdk.core.oauth.provider_registry import GOOGLE, token_for  # noqa: PLC0415

        return await token_for(GOOGLE)

"""A data source whose driver is a script the user wrote.

The nine shipped drivers are Python classes in this package. A source authored
as an ASSET has no class — it has `data_source.json` plus a `fetch.py`, and this
module is what makes that runnable: one adapter that satisfies the
``IngestDriver`` base and answers every verb by calling the
module over ``utils/module_rpc``.

**Why the manifest may declare traits and a builtin may not.** A builtin has a
class to hold `kind`, `record_kind` and `stamps_identity`; an authored source has
only its manifest, so the `traits` block IS its class body. That asymmetry is
enforced at load time (`ManifestSpec`) and consumed here.

**`verify` is per instance.** `DataSource.save()` parks a NEW source in SETUP
when `driver.verify is not None`; a spec declares a human setup step by carrying
a non-empty ``setup_wiki``, and only then does the adapter get the verb.

**The module never writes its own header.** ``source_id``, ``provider``, ``kind``
and ``segment_key`` are stamped here from the source and the spec, exactly as
``rss.py`` does. A module that sends them has them ignored — otherwise an
authored source could mint records attributed to a different source.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys
from typing import Any, Optional

from flow_sdk.builtin.data_source_spec import AuthSpec, DataSourceSpec, Runtime, TraitsSpec
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.driver import IngestDriver, FetchResult, SegmentCursorView, SegmentRef, SetupVerdict
from flow_sdk.ingest.health import SourceError
from flow_sdk.utils.module_rpc import ModuleFailure, call_module

logger = logging.getLogger(__name__)

#: The request envelope version. A module that does not understand the host it
#: was handed exits 3 rather than guessing.
PROTOCOL = 1

#: Concurrent module spawns across ALL script sources. The poller dispatches
#: every due source on the same heartbeat tick, so without this N authored
#: sources become N simultaneous processes. Same reasoning and same shape as
#: `agent.py`'s MAX_CONCURRENT_AGENTS.
MAX_CONCURRENT_MODULES = 4
_slots = asyncio.Semaphore(MAX_CONCURRENT_MODULES)

#: Per-verb ceilings. A ceiling on ONE call, never a retry budget — the next
#: scheduled tick is the retry (the rule `ingest/http.py` states for HTTP).
DEADLINES = {"segments": 30, "fetch": 120, "verify": 30}


class ScriptSource(IngestDriver):
    """One authored source. Constructed per spec, registered like any driver."""

    #: Authored sources do not send. `inbox/outbound.py` then reports "cannot
    #: send" rather than spawning something that does not exist.
    sends = False

    def __init__(self, *, name: str, folder: str, traits: Optional[TraitsSpec] = None, env=(), setup: bool = False):
        traits = traits or TraitsSpec()
        #: A spec with a human setup step (`setup_wiki`) gets the verb; the
        #: engine reads `driver.verify is None` to decide whether to park in SETUP.
        self.verify = self._verify if setup else None
        self.provider = name
        self.folder = folder
        #: The ontology kind for the SOURCE row. Derived, not declared: it is a
        #: fact about which driver this is, and `sync_source` stamps it.
        self.kind = f"datasource.{name}"
        #: Stamped on every item. Decides inbox membership — the projection
        #: admits `content.message.*` and nothing else.
        self.record_kind = traits.emits
        self.stamps_identity = traits.owns_bytes
        self._channel = traits.channel
        self._env_names = tuple(str(e) for e in env)

    # ── the Protocol ──────────────────────────────────────────────────────

    async def segments(self, source) -> list[SegmentRef]:
        """Ask the module what it can sync — one spawn.

        The nine builtins answer from `source.config`; this one has to run the
        module to know, which is why the Protocol declares the verb async for
        all ten rather than making the call site guess.
        """
        data = await self._call(source, "segments", {})
        raw = data.get("segments") if isinstance(data, dict) else None
        if raw is None:
            return []
        if not isinstance(raw, list):
            raise SourceError.config("bad_response", "segments must be a list")
        out: list[SegmentRef] = []
        for entry in raw:
            if not isinstance(entry, dict) or not str(entry.get("key") or ""):
                raise SourceError.config("bad_response", "every segment needs a key")
            out.append(SegmentRef(key=str(entry["key"]), label=str(entry.get("label") or "")))
        return out

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        state = dict(cursor.state or {})
        data = await self._call(
            source,
            "fetch",
            {
                "cursor": {
                    "segment_key": cursor.segment_key,
                    "state": state,
                    "window_start": cursor.window_start,
                    "first_run": cursor.first_run,
                }
            },
        )
        if not isinstance(data, dict):
            raise SourceError.config("bad_response", "fetch must return an object")

        # ABSENT `state` means "carry mine forward". `sync.py` assigns
        # `cursor.state = result.next_state or {}` unconditionally, so echoing
        # the incoming state is what stops a module that returns `{"items": []}`
        # from silently resetting its own resumption point every tick. Only an
        # explicit `{}` clears.
        if "state" in data:
            next_state = data["state"]
            if not isinstance(next_state, dict):
                raise SourceError.config("bad_response", "state must be an object")
        else:
            next_state = state

        return FetchResult(
            items=[self._item(source, cursor, raw) for raw in (data.get("items") or [])],
            refs=[str(r) for r in (data.get("refs") or [])],
            tombstones=[str(t) for t in (data.get("tombstones") or [])],
            renames={str(k): str(v) for k, v in (data.get("renames") or {}).items()},
            next_state=next_state,
            high_water=data.get("high_water"),
            unchanged=bool(data.get("unchanged")),
        )

    def _item(self, source, cursor: SegmentCursorView, raw: Any) -> SourceItemSpec:
        """One module dict → an SourceItemSpec, with the header stamped HERE.

        An empty `external_id` is a config failure rather than a skip: the
        natural key is (source_id, segment_key, external_id), so a blank one
        collapses every item in the segment onto a single row.
        """
        if not isinstance(raw, dict):
            raise SourceError.config("bad_response", "every item must be an object")
        external_id = str(raw.get("external_id") or "")
        if not external_id:
            raise SourceError.config("bad_response", "every item needs an external_id")
        return SourceItemSpec(
            data_source_id=str(source.id),
            provider=self.provider,
            kind=self.record_kind,
            segment_key=cursor.segment_key,
            external_id=external_id,
            name=str(raw.get("title") or ""),
            body=str(raw.get("body") or ""),
            occurred_at=raw.get("occurred_at"),
            author_external_id=raw.get("author_external_id"),
            author_display=raw.get("author_display"),
            permalink=raw.get("permalink"),
            thread_key=raw.get("thread_key"),
            reply_to_external_id=raw.get("reply_to_external_id"),
            segment_label=str(raw.get("segment_label") or ""),
            raw=raw.get("raw") if isinstance(raw.get("raw"), dict) else None,
        )

    def channel_for(self, source) -> str:
        return self._channel

    # ── transport ─────────────────────────────────────────────────────────

    async def _call(self, source, verb: str, extra: dict) -> Any:
        script = os.path.join(self.folder, DataSourceSpec.SCRIPT_FILE)
        executor = await self._executor()

        env = self._env(source)
        request = {
            "protocol": PROTOCOL,
            "source": {
                "id": str(source.id),
                "name": getattr(source, "name", ""),
                "account_key": getattr(source, "account_key", ""),
                "config": dict(getattr(source, "config", None) or {}),
                "window_days": getattr(source, "window_days", 7),
            },
            **extra,
        }
        try:
            async with _slots:
                result = await call_module(
                    executor,
                    script=script,
                    verb=verb,
                    request=request,
                    workdir=self._workdir(source, extra),
                    env=env,
                    timeout=DEADLINES.get(verb),
                    # Always, never conditional on the exec bit: an
                    # `agentic-assets` folder travels through git and share
                    # bundles, and the mode bit does not survive every path.
                    # `sys.executable` also pins the interpreter that has
                    # flow_sdk on it.
                    argv_prefix=[sys.executable],
                )
        except ModuleFailure as exc:
            # A module that is not there will never appear by retrying, and the
            # exit code does not say so — the interpreter exists, so a missing
            # script is exit 2, not a spawn failure. The distinction is drawn
            # HERE, on the failure path, rather than by stat-ing before every
            # successful call.
            if not await executor.exists(script):
                raise SourceError.config(
                    "missing_module", f"{DataSourceSpec.SCRIPT_FILE} is missing from {self.folder}"
                ) from exc
            detail = f"{exc}{f' — {exc.logs[-500:]}' if exc.logs else ''}"
            if exc.kind == "config":
                raise SourceError.config("module_config", detail) from exc
            raise SourceError.transient("module_transient", detail) from exc
        return result.data

    def _env(self, source) -> dict[str, str]:
        """The names the manifest declared, plus the instance pin.

        An OVERLAY, not a scrub — on the local executor the child inherits the
        full environment regardless. So this is a fail-fast declaration and a
        forwarding list for a remote node, and it is NOT confinement; the doc
        says so rather than implying isolation the code does not provide.
        """
        env = {"FLOW_INSTANCE": os.environ.get("FLOW_INSTANCE", "")}
        missing = [name for name in self._env_names if not os.environ.get(name)]
        if missing:
            raise SourceError.config("missing_env", f"set {', '.join(missing)}")
        for name in self._env_names:
            env[name] = os.environ[name]
        return {k: v for k, v in env.items() if v}

    def _workdir(self, source, extra: dict) -> str:
        """Scratch for one source+segment.

        Deliberately NOT the spec folder: `call_module` writes `request.json`
        into the workdir, and writing into `agentic-assets` dirties a
        git-tracked tree — the same failure `stamps_identity` exists to prevent.
        """
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        segment = str((extra.get("cursor") or {}).get("segment_key") or "_")
        leaf = hashlib.sha1(segment.encode("utf-8")).hexdigest()[:12]
        return str(get_instance_settings().instance_dir / "ingest" / str(source.id) / leaf)

    async def _verify(self, source) -> SetupVerdict:
        data = await self._call(source, "verify", {})
        if not isinstance(data, dict):
            return SetupVerdict.waiting("the module's verify did not answer")
        pending = tuple(str(p) for p in (data.get("pending") or []))
        detail = str(data.get("detail") or "")
        return SetupVerdict.ok(detail) if data.get("ready") else SetupVerdict.waiting(detail, pending)

    @staticmethod
    async def _executor():
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        node = await ComputeNode.get_local()
        return node.get_command_executor()


def _auth_env(spec) -> tuple[str, ...]:
    """The env names the spec's auth declares (``AuthSpec`` or its dict)."""
    raw = getattr(spec, "auth", None)
    return tuple(AuthSpec.model_validate(raw).env) if raw else ()


def _traits_of(spec) -> "TraitsSpec":
    """The spec's traits as the header validated them (``TraitsSpec`` or its dict)."""
    return TraitsSpec.model_validate(getattr(spec, "traits", None) or {})


def driver_for_spec(spec) -> Optional[ScriptSource]:
    """An adapter for one `DataSourceSpec`, or None when it needs no driver.

    `runtime == builtin` means the manifest describes a driver that already
    exists as a class — registering anything for it would shadow the real one.
    """
    if str(getattr(spec, "runtime", "") or "") != Runtime.SCRIPT.value:
        return None
    # `asset_ref` is declared `Optional[str]` but arrives as an `FSRef` on the
    # in-process path, so handle both. `.path` is FSRef's public accessor;
    # `str(ref)` on one yields `FSRef('/path')`, which would silently produce a
    # module path that cannot exist.
    ref = getattr(spec, "asset_ref", None)
    folder = str(getattr(ref, "path", ref) or "")
    if not folder:
        return None
    return ScriptSource(
        name=str(spec.name),
        folder=folder,
        # Reconstructed through the manifest's own dataclass rather than read by
        # string key: the row stores a plain dict, so a renamed trait would
        # otherwise default silently — an `emits` rename means a blank
        # `record_kind`, and records land outside the inbox projection with
        # nothing raising.
        traits=_traits_of(spec),
        env=_auth_env(spec),
        setup=bool(str(getattr(spec, "setup_wiki", "") or "")),
    )

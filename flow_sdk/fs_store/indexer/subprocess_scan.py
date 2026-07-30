"""SubprocessScanIndexer — an FSIndexer whose DISCOVERY phase runs off-process.

Only ``scan()`` is displaced. ``index()`` is inherited verbatim, so the
per-record loop (``from_disk_fn`` → ``sync_to_db`` → ``_commit_batch``) and every
SQLite write stay in the server process.

That split is deliberate and load-bearing. SQLite serializes writers regardless
of which process issues them, so moving the writes off-process buys no write
throughput at all — while losing the ``_session_ctx`` contextvar handshake that
stops nested writes from self-contending, ``record_sync_guard``, the
``_COMPUTE_ACTIVITIES`` single-flight gate, and ``_DB_LIFECYCLE_LOCK``. It would
also break the rule stated at ``graph_workflow_manager/function_runner.py``: *a subprocess
must never open the instance DB directly.* The walk, by contrast, is GIL-bound
CPU plus filesystem I/O touching no DB — the one part a separate process really
does parallelize.

Failure is always **fail-open**: any problem with the child (spawn failure, bad
JSON, missing terminal result line, non-zero exit, kill) logs one warning and
falls back to the in-process walk, mirroring ``_maybe_rs_indexer``'s temperament.
The run still completes with a correct, complete candidate set — just in-process.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.ndjson_stream import (
    candidate_from_fsref,
    fsrefs_from_candidates,
    stream_ndjson,
)

logger = logging.getLogger(__name__)

CHILD_MODULE = "flow_sdk.fs_store.indexer.scan_child"

# Latched when the child cannot run in this deployment at all — a frozen build
# whose sys.executable isn't a Python, a sandbox that forbids spawning, a broken
# `-m` import path. Without it every subsequent scan would pay a doomed spawn and
# then walk the whole tree in-process anyway: 2x the work, forever. Per-run data
# failures (bad JSON, truncated stream) do NOT latch — those can succeed next time.
# Cleared by ``reset_shared_indexer`` so flipping the preference re-probes.
_CHILD_UNAVAILABLE = False


def reset_child_availability() -> None:
    """Re-enable child probing after a deliberate backend change."""
    global _CHILD_UNAVAILABLE
    _CHILD_UNAVAILABLE = False


def opts_to_payload(opts: IndexerOptions) -> dict:
    """The JSON-able subset of ``IndexerOptions`` the walk actually reads.

    Deliberately excluded: ``on_progress`` (a coroutine — handled by streaming
    progress lines back instead), ``scope_filter`` (consumed only by the
    DB-side orphan narrowing, which never leaves the parent), ``orphan_action``
    and ``dedup_on_adopt`` (index-phase only), and ``roots`` (serialized
    separately as candidate payloads).
    """
    return {
        "types": [str(t) for t in opts.types] if opts.types else None,
        "limit": opts.limit,
        "limit_per_type": opts.limit_per_type,
        "include_temp": opts.include_temp,
        "gitignore": opts.gitignore,
        "project_id": opts.project_id,
        "force": opts.force,
    }


class SubprocessScanIndexer(FSIndexer):
    """FSIndexer that runs its walk in a child process."""

    async def scan(self, opts: IndexerOptions | None = None) -> list[FSRef]:
        global _CHILD_UNAVAILABLE
        opts = opts if opts is not None else IndexerOptions()
        if _CHILD_UNAVAILABLE:
            return await super().scan(opts)
        try:
            return await self._scan_via_child(opts)
        except (OSError, ValueError) as e:
            # Spawn/interpreter failure — the child can never work here, so stop
            # paying for the attempt on every scan.
            _CHILD_UNAVAILABLE = True
            logger.warning(
                "[subprocess-scan] child cannot be spawned (%s); using the in-process "
                "scan for the rest of this process", e,
            )
            return await super().scan(opts)
        except Exception:
            logger.warning(
                "[subprocess-scan] child scan failed; falling back to in-process scan",
                exc_info=True,
            )
            return await super().scan(opts)

    async def _scan_via_child(self, opts: IndexerOptions) -> list[FSRef]:
        from flow_sdk.fs_store.record_paths import (  # noqa: PLC0415
            get_default_records_data_root,
            get_default_records_root,
        )

        roots = opts.roots if opts.roots is not None else (tuple(self._roots) or None)
        request = {
            "roots": [candidate_from_fsref(r) for r in roots] if roots is not None else None,
            "opts": opts_to_payload(opts),
            "progress": opts.on_progress is not None,
            # The shadow-store paths the PARENT is actually using, not what the
            # child would re-derive from instance settings. These are process
            # globals that callers can override at runtime, and several walkers
            # read the records root to discover projects — a child that re-derived
            # them would silently walk a different store and return a candidate
            # set that disagrees with the in-process scan.
            "records_root": str(get_default_records_root()),
            "records_data_root": str(get_default_records_data_root()),
        }

        # Re-stamp FLOW_INSTANCE hard rather than setdefault-ing it. An empty or
        # absent value resolves the child to the `prod` instance, and both
        # `special_folders._home()` and `default_roots()` key off
        # get_instance_settings() — so a mis-resolved child would happily walk a
        # different instance's tree and return candidates for the wrong project.
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        env = dict(os.environ)
        env["FLOW_INSTANCE"] = get_instance_settings().instance_name

        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            CHILD_MODULE,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(request).encode())
        await proc.stdin.drain()
        proc.stdin.close()

        result_json, candidates = await stream_ndjson(
            proc,
            opts.on_progress,
            collect_candidates=True,
            label="scan_child",
        )

        # A missing terminal result line means the child died mid-stream. That is
        # indistinguishable from a clean scan by candidate count alone, and a
        # TRUNCATED candidate set is the most dangerous input `index()` can get:
        # the orphan sweep would treat every record the child never emitted as
        # orphaned. Refuse it and let the caller fall back.
        if result_json is None:
            raise RuntimeError(
                f"scan_child emitted no result line (got {len(candidates)} candidates) "
                "— treating as a truncated stream"
            )
        reported = result_json.get("candidates")
        if reported is not None and int(reported) != len(candidates):
            raise RuntimeError(
                f"scan_child candidate count mismatch: reported {reported}, "
                f"received {len(candidates)}"
            )
        return fsrefs_from_candidates(candidates)

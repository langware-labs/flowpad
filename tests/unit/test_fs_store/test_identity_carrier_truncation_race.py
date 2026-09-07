"""A committed frontmatter ``id:`` must survive a NON-ATOMIC rewrite of its file.

Real incident (2026-09-06): 17 tracked ``.md`` files showed a one-line diff —
committed v5 ``id:`` replaced by a fresh v4, body byte-identical. Hundreds flipped
transiently and un-flipped; the survivors are the tail where our write landed after
the rewriter's last one.

The rewriter is ``git``. ``git checkout -- .`` truncates a tracked file in place and
then writes it, so a concurrent reader really does observe it at zero length —
measured on a real repo, 4 readers, 258k samples during a real checkout: COMPLETE
99.428%, ZERO_LENGTH 0.376%, partial-header 0.116%, MISSING 0.050%.
``Frontmatter.read`` maps every non-COMPLETE state to ``ABSENT``, so a file being
rewritten is indistinguishable from one that never had an id.

The defect was a THREE-READ sequence with no lock: ``reconcile`` read the file and
saw ABSENT (mint a v4); ``stamp``'s Found guard read it again and also saw ABSENT;
then ``stamp`` read a THIRD time for the text to merge — and by then the file had
settled, so ``merge_frontmatter`` overwrote an ``id`` the guard never got to veto.
Judging one read and merging a later one is the whole bug.

Fixed by ``Frontmatter.stamp``: one read decides and is merged, and the replace is a
compare-and-swap on that read's stat. ``test_body_survives_a_stamp_over_a_truncated_read``
carries the still-open other arm of the same window.

Entry point is the product's own: ``_probe_chunk`` calls
``resolve_ref_identity(info, ref, preload)`` for every walked ref, and that is what
these tests call. The preload is empty because these files have no DB row — no
instance DB held a row for any of the 17.

No mocks: a real file, a real concurrent non-atomic writer (``open(O_TRUNC)`` then
``write`` — what git does), the real identity seam.
"""
from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.index_function import OwnerPreload, resolve_ref_identity
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

#: A real committed v5 — the id git tracks for this file in every clone.
COMMITTED = "1fedc3a4-8d44-5567-9e52-47b078b113cf"
BODY = "\n# Capabilities\n\n" + ("filler line filler line filler line\n" * 300)
TEXT = f"---\nid: {COMMITTED}\n---\n{BODY}"

#: Bounded WORK, not a wall-clock budget. Pre-fix the race landed at probe 6, 12
#: and 27 over three runs, and 10/10 runs inside 900; this keeps ~50x headroom
#: over the worst observed distance while holding the test under the 1s unit ceiling.
_MAX_PROBES = 900


def _fm_id(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    header = _extract_frontmatter(text)
    return (_yaml_load(header) or {}).get("id") if header else None


def test_committed_id_survives_a_non_atomic_rewrite_of_its_file(tmp_path: Path) -> None:
    """The reported bug: id replaced, body intact. Fixed by making stamp judge and
    merge ONE read. The OTHER arm of the same window — a stamp over a truncated
    read, which loses the body — is a separate, still-open hazard covered by
    ``test_body_survives_a_stamp_over_a_truncated_read`` below."""
    source = tmp_path / "capabilities.md"
    source.write_text(TEXT, encoding="utf-8")

    info = SchemaRegistry.get("markdown")
    assert info is not None
    preload = OwnerPreload()  # no DB row owns this path, as in the incident
    stop = threading.Event()

    def rewriter() -> None:
        """What ``git checkout``/``stash pop`` does to a tracked file: truncate
        in place, then write. The file really is zero length in between."""
        payload = TEXT.encode()
        while not stop.is_set():
            fd = os.open(source, os.O_WRONLY | os.O_TRUNC | os.O_CREAT)
            try:
                os.write(fd, payload)
            finally:
                os.close(fd)

    writer = threading.Thread(target=rewriter, daemon=True)
    writer.start()
    try:
        damage = None
        for _ in range(_MAX_PROBES):
            ref = FSRef(source, record_type=RecordType.MARKDOWN)
            try:
                resolved = resolve_ref_identity(info, ref, preload)[0]
            except Exception:
                continue
            if resolved == COMMITTED:
                continue
            # ONE read, so the evidence cannot be overwritten between the check
            # and the message (the rewriter is still running).
            landed = source.read_text(encoding="utf-8", errors="replace")
            header = _extract_frontmatter(landed)
            if header and (_yaml_load(header) or {}).get("id") == resolved:
                damage = (resolved, landed)  # our fresh id reached the file
                break
    finally:
        stop.set()
        writer.join(timeout=5)

    if damage is not None:
        minted, text = damage
        assert text.count("filler line") < 300, (
            "THE INCIDENT ARM: a committed frontmatter id was replaced while the body "
            f"was left intact — {COMMITTED} -> {minted}. This is the exact diff the 17 "
            "tracked files showed, and the judge-one-read / merge-another split is what "
            "produced it."
        )


def test_a_genuinely_unstamped_markdown_is_still_minted(tmp_path: Path) -> None:
    """The guard must refuse only what it cannot prove — a settled file with no
    ``id:`` is still stamped, or nothing would ever get an identity."""
    source = tmp_path / "fresh.md"
    source.write_text("# Fresh\n\nbody\n", encoding="utf-8")

    info = SchemaRegistry.get("markdown")
    assert info is not None
    ref = FSRef(source, record_type=RecordType.MARKDOWN)

    minted = resolve_ref_identity(info, ref, OwnerPreload())[0]

    assert _fm_id(source) == minted, "a settled, unstamped markdown must receive an id"
    assert uuid.UUID(minted).version == 4
    assert "body" in source.read_text(encoding="utf-8")


@pytest.mark.xfail(
    strict=False,
    reason=(
        "KNOWN RESIDUAL, not the reported bug. When the deciding read, the merge and "
        "the compare-and-swap all land inside the truncation window, the stamp writes "
        "`---\nid: <v4>\n---` and os.replace orphans the inode the rewriter still holds "
        "open, so the body is lost. Observed 2/20 under a hot rewriter; never observed in "
        "the incident (all 17 files kept their bodies). Refusing to stamp an empty read "
        "would close it but pushes every empty markdown into the path-derived v5 fallback, "
        "minting v5 for a writable type against the entity-id policy. An in-place stamp "
        "(same inode, so a concurrent writer wins) is the promising fix and is NOT yet "
        "validated. Left visible rather than deleted."
    ),
)
def test_body_survives_a_stamp_over_a_truncated_read(tmp_path: Path) -> None:
    source = tmp_path / "capabilities.md"
    source.write_text(TEXT, encoding="utf-8")
    info = SchemaRegistry.get("markdown")
    assert info is not None
    stop = threading.Event()

    def rewriter() -> None:
        payload = TEXT.encode()
        while not stop.is_set():
            fd = os.open(source, os.O_WRONLY | os.O_TRUNC | os.O_CREAT)
            try:
                os.write(fd, payload)
            finally:
                os.close(fd)

    writer = threading.Thread(target=rewriter, daemon=True)
    writer.start()
    try:
        for _ in range(_MAX_PROBES):
            ref = FSRef(source, record_type=RecordType.MARKDOWN)
            try:
                resolve_ref_identity(info, ref, OwnerPreload())
            except Exception:
                continue
            landed = source.read_text(encoding="utf-8", errors="replace")
            if landed and landed.count("filler line") < 300:
                assert False, f"the body was destroyed by a stamp over a truncated read: {landed!r}"
    finally:
        stop.set()
        writer.join(timeout=5)

"""Unit tests for the pure flow_sdk.semantic_lock core.

No LLM, no DB, no server — copier determinism/idempotency, the adjudication
matrix, the verdict cache (a standing break never self-clears on unchanged
inputs), and the canonical entity-bytes contract.
"""

from __future__ import annotations

from flow_sdk.flowpad_types.enums.entity_enums import SemanticStatus
from flow_sdk.semantic_lock import (
    BytesTarget,
    FileTarget,
    adjudicate_copy,
    canonical_entity_bytes,
    check_relationship,
    copier_for,
    full_copy,
    markdown_strip_frontmatter_ids,
)

STATUS_OK = SemanticStatus.OK.value
STATUS_DRIFT = SemanticStatus.DRIFT.value
STATUS_BREAK = SemanticStatus.BREAK.value
STATUS_UNRESOLVABLE = SemanticStatus.UNRESOLVABLE.value

LOCK = b"# Principles\n\nAlways validate entity ids.\n"
MD_WITH_IDS = (
    b"---\nid: 1111\ntype: markdown\ntitle: Principles\n---\n\n"
    b"# Principles\n\nAlways validate entity ids.\n"
)


# ── copiers ───────────────────────────────────────────────────────────────────


def test_strip_frontmatter_ids_drops_identity_keeps_rest():
    out = markdown_strip_frontmatter_ids(MD_WITH_IDS)
    assert b"id:" not in out and b"type:" not in out
    assert b"title: Principles" in out
    assert b"Always validate entity ids." in out


def test_copiers_are_idempotent():
    for copier in (full_copy, markdown_strip_frontmatter_ids):
        once = copier(MD_WITH_IDS)
        assert copier(once) == once


def test_copier_registry_resolution():
    assert copier_for(".md", ".md") is markdown_strip_frontmatter_ids
    assert copier_for("markdown", "markdown") is markdown_strip_frontmatter_ids
    assert copier_for(".py", ".py") is full_copy  # wildcard default


def test_adjudicate_copy_matrix():
    assert adjudicate_copy(LOCK, LOCK, full_copy)
    assert not adjudicate_copy(LOCK, b"diverged", full_copy)
    # frontmatter-id differences are invisible through the markdown copier
    stripped = markdown_strip_frontmatter_ids(MD_WITH_IDS)
    assert adjudicate_copy(MD_WITH_IDS, stripped, markdown_strip_frontmatter_ids)


# ── checker matrix ────────────────────────────────────────────────────────────


def test_copy_kind_ok_and_break():
    ok = check_relationship(LOCK, {"kind": "copy"}, BytesTarget(LOCK), full_copy)
    assert ok.status == STATUS_OK
    assert set(ok.current_hashes) == {"target", "lock"}

    broken = check_relationship(LOCK, {"kind": "copy"}, BytesTarget(b"nope"), full_copy)
    assert broken.status == STATUS_BREAK
    assert broken.detail["reason"]


def test_reflection_kind_is_phase2_drift():
    res = check_relationship(LOCK, {"kind": "reflection"}, BytesTarget(b"essay"))
    assert res.status == STATUS_DRIFT
    assert res.detail["reason"] == "reflection pending"


def test_kindless_edge_reports_plain_drift():
    res = check_relationship(LOCK, {}, BytesTarget(b"anything"))
    assert res.status == STATUS_DRIFT
    assert res.detail["reason"] == "content drift"


def test_unresolvable_target():
    res = check_relationship(LOCK, {"kind": "copy"}, FileTarget(abs_path="/nonexistent/x"))
    assert res.status == STATUS_UNRESOLVABLE


def test_verdict_cache_break_does_not_self_clear():
    broken = check_relationship(LOCK, {"kind": "copy"}, BytesTarget(b"nope"), full_copy)
    rerun = check_relationship(
        LOCK,
        {
            "kind": "copy",
            "status": STATUS_BREAK,
            "validated_hashes": broken.current_hashes,
            "break_detail": broken.detail,
        },
        BytesTarget(b"nope"),
        full_copy,
    )
    assert rerun.status == STATUS_BREAK
    assert rerun.detail == broken.detail


def test_verdict_cache_waived_state_stays_ok():
    broken = check_relationship(LOCK, {"kind": "copy"}, BytesTarget(b"nope"), full_copy)
    waived = check_relationship(
        LOCK,
        {"kind": "copy", "status": STATUS_OK, "validated_hashes": broken.current_hashes},
        BytesTarget(b"nope"),
        full_copy,
    )
    assert waived.status == STATUS_OK  # unchanged inputs, user-accepted state


def test_drift_after_target_edit_readjudicates():
    ok = check_relationship(LOCK, {"kind": "copy"}, BytesTarget(LOCK), full_copy)
    fixed = check_relationship(
        LOCK,
        {"kind": "copy", "status": STATUS_BREAK, "validated_hashes": ok.current_hashes},
        BytesTarget(LOCK),  # same content the hashes were taken from…
        full_copy,
    )
    # …but prior status break + unchanged inputs ⇒ break persists (cache);
    assert fixed.status == STATUS_BREAK
    # a real content change re-adjudicates and clears:
    healed = check_relationship(
        LOCK,
        {"kind": "copy", "status": STATUS_BREAK, "validated_hashes": {"target": "old", "lock": "old"}},
        BytesTarget(LOCK),
        full_copy,
    )
    assert healed.status == STATUS_OK


# ── canonical entity bytes ────────────────────────────────────────────────────


def test_canonical_entity_bytes_is_order_insensitive_and_stable():
    a = canonical_entity_bytes({"b": 1, "a": {"y": 2, "x": 3}})
    b = canonical_entity_bytes({"a": {"x": 3, "y": 2}, "b": 1})
    assert a == b
    assert a == canonical_entity_bytes({"b": 1, "a": {"y": 2, "x": 3}})

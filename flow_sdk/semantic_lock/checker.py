"""Checker core — pure drift computation + copy adjudication.

``check_relationship`` consumes plain shapes (lock bytes, a relationship
snapshot dict, a TargetAdapter) and returns a verdict (``CheckResult.status``
holds a ``SemanticStatus`` value). It never touches the DB and never writes
anything — persisting the verdict (and the lock-break Annotations) is the
route layer's job.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from flow_sdk.flowpad_types.enums.entity_enums import DependsOnKind, SemanticStatus
from flow_sdk.llm_index.core import sha256_bytes
from flow_sdk.semantic_lock.copiers import Copier, adjudicate_copy, full_copy
from flow_sdk.semantic_lock.targets import TargetAdapter

# validated_hashes roles ("reflector" joins in phase 2).
ROLE_TARGET = "target"
ROLE_LOCK = "lock"


@dataclass
class CheckResult:
    status: str
    detail: dict = field(default_factory=dict)
    # The hashes that adjudication validated (written back on OK; on BREAK the
    # route layer also advances them so re-runs are read-free — the break
    # itself lives in the Annotation).
    current_hashes: dict = field(default_factory=dict)


def check_relationship(
    lock_bytes: bytes,
    rel: dict,
    target: TargetAdapter,
    copier: Copier = full_copy,
) -> CheckResult:
    """Verdict for one lock → target edge.

    ``rel`` is a plain snapshot of the relationship's semantic fields:
    ``{"kind": ..., "validated_hashes": {...}}``.
    """
    target_bytes = target.resolve()
    if target_bytes is None:
        return CheckResult(
            status=SemanticStatus.UNRESOLVABLE.value,
            detail={"reason": "target bytes unresolvable"},
        )

    lock_hash = sha256_bytes(lock_bytes)
    target_hash = sha256_bytes(target_bytes)
    current = {ROLE_TARGET: target_hash, ROLE_LOCK: lock_hash}

    validated = dict(rel.get("validated_hashes") or {})
    drifted = [
        role for role, now in current.items() if validated.get(role) != now
    ]
    if validated and not drifted:
        # Verdict cache: unchanged inputs reproduce the prior verdict — a
        # standing break stays a break (it clears only via a content change
        # or a user waive), everything else is OK.
        if (rel.get("status") or "") == SemanticStatus.BREAK.value:
            return CheckResult(
                status=SemanticStatus.BREAK.value,
                detail=dict(rel.get("break_detail") or {}) or {"reason": "unchanged since last break"},
                current_hashes=current,
            )
        return CheckResult(status=SemanticStatus.OK.value, current_hashes=current)

    kind = rel.get("kind") or ""
    if kind == DependsOnKind.COPY.value:
        if adjudicate_copy(lock_bytes, target_bytes, copier):
            return CheckResult(status=SemanticStatus.OK.value, current_hashes=current)
        return CheckResult(
            status=SemanticStatus.BREAK.value,
            detail={
                "reason": "target does not match the copier transform of the lock content",
                "drifted": drifted or list(current),
            },
            current_hashes=current,
        )
    if kind == DependsOnKind.REFLECTION.value:
        # Phase-2 seam: a reflector subagent adjudicates reflection drift.
        return CheckResult(
            status=SemanticStatus.DRIFT.value,
            detail={"reason": "reflection pending", "drifted": drifted or list(current)},
            current_hashes=current,
        )
    # Plain (kind-less) edge under a semantic_lock: hash drift IS the signal.
    return CheckResult(
        status=SemanticStatus.DRIFT.value,
        detail={"reason": "content drift", "drifted": drifted or list(current)},
        current_hashes=current,
    )

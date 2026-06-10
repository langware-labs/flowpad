"""semantic_lock — deterministic core of the SemanticLock checker.

Pure stdlib, llm_index discipline: every deterministic step (target hashing,
copier transforms, drift computation, copy adjudication) is plain Python with
no DB or server imports. The DB-aware route layer
(``flow_sdk/server/routes/semantic_checker.py``) resolves entities and
relationships into the plain shapes this package consumes.

Phase 1 is deterministic-only: ``kind=copy`` edges are fully adjudicated here;
``kind=reflection`` edges stop at ``DRIFT`` ("reflection pending") — the
reflector subagent lands in phase 2 behind the same seam.
"""

from flow_sdk.semantic_lock.checker import CheckResult, check_relationship
from flow_sdk.semantic_lock.copiers import (
    adjudicate_copy,
    copier_for,
    full_copy,
    markdown_strip_frontmatter_ids,
    register_copier,
)
from flow_sdk.semantic_lock.targets import (
    BytesTarget,
    FileTarget,
    TargetAdapter,
    canonical_entity_bytes,
)

__all__ = [
    "CheckResult",
    "check_relationship",
    "TargetAdapter",
    "FileTarget",
    "BytesTarget",
    "canonical_entity_bytes",
    "copier_for",
    "register_copier",
    "full_copy",
    "markdown_strip_frontmatter_ids",
    "adjudicate_copy",
]

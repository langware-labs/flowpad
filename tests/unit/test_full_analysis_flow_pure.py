"""Pure (no I/O, no HTTP) layer of the full analysis flow.

Proves the two deterministic seams the flow rests on:
  1. the product-finder skill scaffolds with a stable v5 id, and
  2. an analysis's skill-attributed findings project into `by_skill` (the bucket
     the Improve step consumes) — while session-level findings stay unattributed.
"""

import uuid

import pytest

from flow_sdk.fs_store.indexer.functions.skill import skill_id_from_name
from flow_sdk.transcript_analyzer.synthesizers.agent_trace import project_findings_by_skill

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SKILL = "product-finder"


def test_skill_id_is_stable_uuid5():
    a = skill_id_from_name(SKILL)
    b = skill_id_from_name(SKILL)
    assert a == b  # deterministic — same skill name → same id every scaffold
    assert uuid.UUID(a).version == 5  # v5 (derived), per the entity-id policy
    assert skill_id_from_name("other") != a


def test_findings_project_into_by_skill():
    issues = [
        {"ts": "2026-06-25T10:00:10Z", "label": "no price-range filter", "skill": SKILL,
         "section_hint": "Search online", "severity": "attention"},
    ]
    divergences = [
        {"ts": "2026-06-25T10:00:20Z", "label": "skipped shipping check", "skill": SKILL},
        {"ts": "2026-06-25T10:00:30Z", "label": "wrong overall goal"},  # session-level, no skill
    ]
    by_skill, unattributed = project_findings_by_skill(divergences, issues)

    assert SKILL in by_skill
    labels = {f["label"] for f in by_skill[SKILL]["findings"]}
    assert labels == {"no price-range filter", "skipped shipping check"}
    # The un-attributed (goal-level) finding is nobody's skill defect.
    assert [f["label"] for f in unattributed] == ["wrong overall goal"]


def test_clean_analysis_has_no_improvable_skills():
    by_skill, unattributed = project_findings_by_skill([], [])
    assert by_skill == {}  # nothing to improve → the loop converges
    assert unattributed == []

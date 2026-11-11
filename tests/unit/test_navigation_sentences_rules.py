"""A sentence a local rule answers (no model, confidence 1) lands where docs/navigation/navigation-sentences.md
says it should: the rule and the suite's ground truth are one decision, never two that drift apart.
i19 found three that had (53, 58, 91)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from flow_sdk.core.dock_address import canonical_address
from flow_sdk.core.navigator import rule_hit

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
from import_navigation_sentences import rows  # noqa: E402

#: Waiting on the owner: "workflows" is the Graph Workflows screen's alias (eac654dc5) and the doc
#: says the dynamic-workflow list; both types are browseable in advanced mode only.
OWNER_DECISION = {58: "\"show workflows\": Graph Workflows screen (alias) or the dynamic workflow list (doc)?"}

RULED = [
    (r["n"], r["sentence"], r["target"], f"/dock/{hit.value}")
    for r in rows()
    if r["target"].startswith("/dock/") and (hit := rule_hit(r["sentence"])) is not None and hit.kind == "view"
]


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.nav_option_space.rules: FAILING? read this tag's rules before
#       changing the navigator's options, rules or thresholds
# flowpad:endcapsule tag
@pytest.mark.parametrize("n,sentence,target,landed", RULED, ids=[f"{n}" for n, *_ in RULED])
def test_a_sentence_a_rule_answers_lands_where_the_doc_says(n, sentence, target, landed):
    if n in OWNER_DECISION:
        pytest.xfail(OWNER_DECISION[n])
    want = target.split("<")[0].split(" ")[0].rstrip("/")
    assert landed.startswith(want) or canonical_address(landed) == canonical_address(want), (sentence, landed, target)

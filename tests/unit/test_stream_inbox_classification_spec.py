"""The auto classifier's result contract: a value that does not hang together is refused."""

import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.stream_inbox_classification_spec import StreamInboxClassification

ROW = {"conversation_id": "c1", "message_id": "m1", "title": "Dana — charged twice", "before": [],
       "proposed": ["stream_inbox.support.refund"], "action": "apply", "reason": "Wants the money back.",
       "asked": {"tag": "stream_inbox.support.refund", "meaning": "Asks for money back", "answer": "approved"}}
ADDED = {"op": "added", "tag": "stream_inbox.support.refund", "meaning": "Asks for money back", "reason": "No tag covers refunds.", "asked_by": 1}


def value(rows=(ROW,), changes=(ADDED,)):
    return {"root": "stream_inbox", "since": "2026-11-09", "until": "2026-11-14", "conversations": list(rows), "tree_changes": list(changes)}


def test_a_coherent_value_fits_and_is_reachable_by_kind():
    parsed = StreamInboxClassification.model_validate(value(rows=[{**ROW, "validation": {"detected": ROW["proposed"][0], "ok": True}}]))
    assert parsed.conversations[0].asked.answer == "approved" and parsed.conversations[0].validation.ok
    assert DataSpec.parse("stream_inbox.classification") is StreamInboxClassification


@pytest.mark.parametrize(
    "broken, says",
    [
        (value(rows=[{**ROW, "action": "change"}]), "it is 'apply'"),
        (value(rows=[{**ROW, "proposed": ["crm.lead"], "asked": None}]), "not a tag under"),
        (value(rows=[ROW, ROW]), "appears twice"),
        (value(rows=[{**ROW, "asked": {**ROW["asked"], "answer": "use_existing"}}]), "`use` names"),
        (value(changes=[{"op": "removed", "tag": "stream_inbox.support.refund", "reason": "Duplicate."}]), "removed or moved by this run"),
        (value(rows=[], changes=[{"op": "moved", "tag": "stream_inbox.sales.intro", "reason": "Belongs to sales."}]), "old name"),
        (value(rows=[], changes=[{**ADDED, "meaning": None}]), "says its meaning"),
        (value(rows=[{**ROW, "verdict": "applied"}]), "Extra inputs"),
    ],
)
def test_a_value_that_does_not_hang_together_is_refused(broken, says):
    with pytest.raises(ValidationError, match=says):
        StreamInboxClassification.model_validate(broken)

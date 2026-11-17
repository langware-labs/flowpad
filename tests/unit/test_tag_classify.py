"""The generic tag classifier: one decision-API choice over a root's subtree → one full dot tag."""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.schema.data_spec.message_state_spec import MessageState
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.tag_classification_spec import MessageContextSpec
from flow_sdk.tags import classify as classifier
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

CHOICES = {"stream_inbox.support.billing": "Invoices and charges", "stream_inbox.support.refund": "Asks for money back"}
CONTEXT = MessageContextSpec(message=MessageState(text="I want my money back for the double charge"))


async def test_returns_the_chosen_full_tag(decision_double):
    decision_double["answers"] = {"tag": "stream_inbox.support.refund"}
    answer = await classifier.choose(CONTEXT, CHOICES)
    assert answer.exit_code is ExitCode.OK and answer.has_value
    assert answer.value.tag == "stream_inbox.support.refund"
    assert len(decision_double["invoked"]) == 1


async def test_a_meaning_edit_moves_the_answer(decision_double):
    decision_double["match"] = True
    assert (await classifier.choose(CONTEXT, CHOICES)).value.tag == "stream_inbox.support.refund"
    edited = {**CHOICES, "stream_inbox.support.billing": "A double charge they dispute or want back"}
    assert (await classifier.choose(CONTEXT, edited)).value.tag == "stream_inbox.support.billing"


async def test_no_decision_api_is_not_a_value(decision_double):
    decision_double["status"] = 429
    answer = await classifier.choose(CONTEXT, CHOICES)
    assert answer.exit_code is ExitCode.NOT_YET and not answer.has_value and not answer.ran
    assert answer.unavailable


async def test_empty_and_single_trees_never_call():
    assert (await classifier.choose(CONTEXT, {})).exit_code is ExitCode.NOT_APPLICABLE
    only = await classifier.choose(CONTEXT, {"stream_inbox.support": "help"})
    assert only.value.tag == "stream_inbox.support" and not only.ran


@async_context
async def test_options_are_the_root_subtree_only():
    from flow_sdk.builtin.tag import Tag

    root = f"qa{mint_uuid()[:8]}"
    await Tag(name=f"{root}.support", description="help").save()
    await Tag(name=f"{root}.support.billing", description="charges").save()
    await Tag(name=f"{root}.old", deprecated=True).save()
    await Tag(name=f"{root}x.outside").save()
    assert await classifier.options(root) == {f"{root}.support": "help", f"{root}.support.billing": "charges"}

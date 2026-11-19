"""The Stream Inbox tag classifier, judged on the messages a person confirmed a tag for.

Each row's message context goes through the generic classifier (``flow_sdk.tags.classify``) with the tag
tree as it is NOW, so a run after a meaning was rewritten shows what the rewrite did. Right = the same tag
as the confirmed one; "no tag fits" (an empty tag) is an answer like any other. A tag the tree no longer
has cannot be picked, so its rows read wrong until they are relabelled.
"""

from flow_sdk.evals import RowEval, Verdict, golds
from flow_sdk.schema.data_spec.eval_spec import EvalTrace


async def evaluate_row(row):
    from flow_sdk.stream_inbox.message_tags import classify, ontology  # noqa: PLC0415

    gold = golds(row)[0]
    expected = (gold.get("tag") if isinstance(gold, dict) else getattr(gold, "tag", "")) or ""
    answer = await classify(row.input.message, await ontology())
    trace = EvalTrace(kind="decision.run", value=answer.run.model_dump(mode="json", exclude_none=True)) if answer.run is not None else None
    if not answer.ok or answer.value is None:
        return RowEval(verdict=Verdict.ERROR, error=answer.detail or "the classifier did not answer", trace=trace,
                       labels={"expected": expected or "(none)"})
    landed = answer.value.tag or ""
    return RowEval(prediction=answer.value.model_dump(mode="json"), verdict=Verdict.CORRECT if landed == expected else Verdict.WRONG,
                   score=answer.value.confidence, trace=trace, labels={"expected": expected or "(none)", "landed": landed or "(none)"})

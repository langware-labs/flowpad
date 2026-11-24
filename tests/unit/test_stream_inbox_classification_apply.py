"""Applying a proposed Stream Inbox classification: the tree changes, the tags, the ground truth, the eval."""
import pytest

from flow_sdk import evals
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.tag import Tag
from flow_sdk.core import log_dataset
from flow_sdk.schema.data_spec.stream_inbox_classification_spec import StreamInboxClassification, action_of
from flow_sdk.schema.data_spec.tag_classification_spec import TagClassification
from flow_sdk.stream_inbox import classification, message_tags
from flow_sdk.tags.classify import DecisionVerdict
from tests.pytest_plugin import async_context


@pytest.fixture(autouse=True)
def kept(monkeypatch, tmp_path):
    # Shaped like the real root (<instance>/agentic-assets/dataset): the rows must stay beside the manifest.
    kept_root = tmp_path / "instance" / "agentic-assets" / "dataset"
    monkeypatch.setattr(log_dataset, "kept_datasets", lambda: kept_root)
    monkeypatch.setattr(classification.GROUND_TRUTH, "root", lambda: kept_root)
    monkeypatch.setattr(classification.GROUND_TRUTH, "_row", None)
    monkeypatch.setattr(message_tags, "wake", lambda _id: None)


async def tree(*leaves):
    """A private subtree under the classification root: ``{leaf: full name}``."""
    base = "stream_inbox.t" + mint_uuid().replace("-", "")[:10]
    await Tag(name=base, stream_inbox=True).save()
    for leaf in leaves:
        await Tag(name=f"{base}.{leaf}", description=f"about {leaf}", stream_inbox=True).save()
    return base, {leaf: f"{base}.{leaf}" for leaf in leaves}


def row(message, before, proposed, **more):
    return {"conversation_id": f"c-{message.id}", "message_id": str(message.id), "title": message.text, "before": before,
            "proposed": proposed, "action": action_of(before, proposed), "reason": "because", **more}


@async_context
async def test_apply_makes_rows_and_tree_real_and_keeps_them_as_ground_truth():
    base, t = await tree("billing", "demo", "intro")
    refund, moved = f"{base}.refund", f"{base}.sales.intro"
    await Tag(name=f"{t['intro']}.call", stream_inbox=True).save()
    charged, invoice, hello = [await FlowMessage(text=text).save() for text in ("charged twice", "wrong invoice", "book a demo")]
    await message_tags.change_tags(invoice.id, add=[t["billing"]])
    await message_tags.change_tags(hello.id, add=[t["demo"]])
    value = StreamInboxClassification.model_validate({"conversations": [
        row(charged, [], [refund]), row(invoice, [t["billing"]], [t["billing"]]), row(hello, [t["demo"]], [moved])],
        "tree_changes": [
            {"op": "added", "tag": refund, "meaning": "Asks for money back", "reason": "new", "asked_by": 1},
            {"op": "updated", "tag": t["billing"], "was": "about billing", "meaning": "Invoices only", "reason": "sharper"},
            {"op": "moved", "tag": moved, "was": t["intro"], "reason": "belongs to sales"},
            {"op": "removed", "tag": t["demo"], "merged_into": moved, "reason": "same as intro"}]})

    # One row alone brings the tag it needs, and nothing else of the tree.
    first = await classification.apply(value, conversations=[f"c-{charged.id}"], tree=False)
    assert first == {"applied": [f"c-{charged.id}"], "failed": {}, "tree": {refund: "applied"}}
    assert (await FlowMessage.get_by_id(charged.id)).tags == [refund]
    assert (await Tag.get_by_id(Tag.allocate_id({"name": t["demo"]}))) is not None

    done = await classification.apply(value)
    assert done["failed"] == {} and done["tree"] == {refund: "already", t["billing"]: "applied", moved: "applied", t["demo"]: "applied"}
    names = {d["name"]: d["description"] for d in await message_tags.ontology()}
    assert names[t["billing"]] == "Invoices only" and moved in names and f"{moved}.call" in names   # a move takes its children
    assert t["demo"] not in names and t["intro"] not in names
    stored = await FlowMessage.get_by_id(hello.id)
    assert stored.tags == [moved] and stored.message_processing.queue == []    # merged, re-tagged, nothing queued
    assert (await classification.truth())["tags"] == {str(charged.id): refund, str(invoice.id): t["billing"], str(hello.id): moved}

    # A person's later change to a labelled message is moderation: its ground truth follows.
    await message_tags.change_tags(charged.id, replace=[t["billing"]])
    await log_dataset.drain()
    assert (await classification.truth())["tags"][str(charged.id)] == t["billing"]


@async_context
async def test_a_row_whose_tag_is_not_in_the_tree_fails_alone():
    base, t = await tree("billing")
    good, bad = await FlowMessage(text="invoice").save(), await FlowMessage(text="other").save()
    value = StreamInboxClassification.model_validate({"conversations": [row(good, [], [t["billing"]]), row(bad, [], [f"{base}.ghost"])]})
    done = await classification.apply(value)
    assert done["applied"] == [f"c-{good.id}"] and "not in the tag tree" in done["failed"][f"c-{bad.id}"]
    assert (await FlowMessage.get_by_id(bad.id)).tags == []


@async_context
async def test_the_shipped_eval_judges_the_classifier_on_the_ground_truth(monkeypatch):
    base, t = await tree("billing", "refund")
    right, wrong, none = [await FlowMessage(text=text).save() for text in ("invoice", "money back", "thanks")]
    done = await classification.apply(StreamInboxClassification.model_validate({"conversations": [
        row(right, [], [t["billing"]]), row(wrong, [], [t["refund"]]), row(none, [], [])]}))
    assert done["failed"] == {f"c-{none.id}": "No tag is proposed for it."}   # a row with no tag is not ground truth

    async def choose(value, choices):   # the classifier's double: everything about money is billing
        text = value.message.text
        return DecisionVerdict.satisfied("", value=TagClassification(tag="" if text == "thanks" else t["billing"], confidence=0.9))

    monkeypatch.setattr("flow_sdk.tags.classify.choose", choose)
    run, _ = await evals.run(Dataset.at(classification.GROUND_TRUTH.folder()))
    assert run.eval_name == "stream-inbox-tags" and run.metrics["accuracy"] == pytest.approx(1 / 2, abs=1e-3)
    assert (run.counts.get("correct"), run.counts.get("wrong")) == (1, 1)


@async_context
async def test_a_run_hands_its_proposal_in_by_reference_and_the_tree_decides_what_fits(monkeypatch, tmp_path):
    base, t = await tree("billing")
    message = await FlowMessage(text="invoice").save()
    monkeypatch.setattr(classification, "_values", lambda: tmp_path / "values")
    ghost = StreamInboxClassification.model_validate({"conversations": [row(message, [], [f"{base}.ghost"])],
                                                      "tree_changes": [{"op": "added", "tag": t["billing"], "meaning": "x", "reason": "y"}]})
    assert await classification.problems(ghost) == [
        f"tree change added {t['billing']}: the tag already exists",
        f"'invoice': proposed {base}.ghost is neither in the tree nor added by this value"]
    empty = StreamInboxClassification.model_validate({"conversations": [row(message, [], [])]})
    assert "no tag proposed" in (await classification.problems(empty))[0]   # every conversation gets a tag
    good = StreamInboxClassification.model_validate({"conversations": [row(message, [], [t["billing"]])]})
    assert await classification.problems(good) == []
    ref = await classification.submit(good)
    assert ref.startswith("stream_inbox.classification.id.") and classification.submitted(ref) == good
    # A new tag that came with no colour gets one when the proposal is handed in: what is shown is what is applied.
    fresh = StreamInboxClassification.model_validate({"tree_changes": [{"op": "added", "tag": f"{base}.refund", "meaning": "x", "reason": "y"}]})
    assert classification.submitted(await classification.submit(fresh)).tree_changes[0].color in classification._PALETTE


@async_context
async def test_the_decision_model_validates_rows_on_the_tree_to_be_and_one_tag_change_is_approved_alone(monkeypatch):
    base, t = await tree("billing")
    refund = f"{t['billing']}.refund"
    money, hello = [await FlowMessage(text=text).save() for text in ("money back", "hello")]
    value = StreamInboxClassification.model_validate({"conversations": [row(money, [], [refund]), row(hello, [], [t["billing"]])],
        "tree_changes": [{"op": "added", "tag": refund, "meaning": "Asks for money back", "reason": "new"},
                         {"op": "updated", "tag": t["billing"], "was": "about billing", "meaning": "Invoices only", "reason": "sharper"}]})
    offered = {}

    async def choose(context, choices):   # the decision model's double: only "money back" lands, on refund
        offered.update(choices)
        return DecisionVerdict.satisfied("", value=TagClassification(tag=refund if context.message.text == "money back" else "", confidence=0.9))

    monkeypatch.setattr("flow_sdk.tags.classify.choose", choose)
    checked = await classification.validate(value)
    assert (offered[refund], offered[t["billing"]]) == ("Asks for money back", "Invoices only")   # the tree as the value leaves it
    assert [(r.validation.detected, r.validation.ok) for r in checked.conversations] == [(refund, True), ("", False)]
    assert refund not in {d["name"] for d in await message_tags.ontology()}   # validating wrote nothing

    done = await classification.apply(value, conversations=[], tree=[refund])
    assert done == {"applied": [], "failed": {}, "tree": {refund: "applied"}}
    assert {d["name"]: d["description"] for d in await message_tags.ontology()}[t["billing"]] == "about billing"   # not the other change


def test_the_review_app_is_a_nano_app_whose_header_says_what_the_run_proposes():
    from flow_sdk.schema.data_spec.nano_app_spec import read_nano_app, render_header

    page = classification.review_app().read_text(encoding="utf-8")
    app = read_nano_app(page)
    assert (app.name, app.input, app.slots) == ("classification-review", "stream_inbox.classification", ["header", "block", "page"])
    assert render_header(page, {"summary": "1 tag change · 6 conversations · 5 would change"}) == "1 tag change · 6 conversations · 5 would change"

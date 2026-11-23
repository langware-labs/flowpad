"""Applying a Stream Inbox classification, and keeping what was applied as ground truth.

A ``stream_inbox.classification`` value only proposes. ``apply`` makes rows and tag tree changes real on a
person's request -- no automation starts -- and every applied row becomes a row of the instance's kept
dataset ``StreamInboxTags`` (message context -> its confirmed tag): what the tag classifier is evaluated
against. A person changing a labelled message's tags afterwards is moderation: the row follows.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from flow_sdk.core.log_dataset import KeptDataset, rows, spawn
from flow_sdk.schema.data_spec.layout import ROWS_DIR
from flow_sdk.schema.data_spec.stream_inbox_classification_spec import (
    StreamInboxClassification,
    TagTreeChange,
    tags_under,
)
from flow_sdk.tags.grammar import tag_is_within

GROUND_TRUTH = KeptDataset(
    "stream-inbox-tags", "StreamInboxTags", "stream_inbox.tags.dataset",
    "Stream Inbox messages with the tag a person confirmed: applied classifications and later corrections. "
    "The ground truth the tag classifier's eval runs on. Kept on this instance, never in a project.",
)
_ORDER = {"added": 0, "updated": 1, "moved": 2, "removed": 3}


async def _tag(name: str):
    """The live tag of exactly this name. Not ``resolve_tag``: that follows a rename to its successor."""
    from flow_sdk.builtin.tag import Tag  # noqa: PLC0415

    found = await Tag.get_by_id(Tag.allocate_id({"name": name}))
    return found if found is not None and not found.deprecated else None


async def _apply_change(change: TagTreeChange, rules: list) -> str:
    """One tree change; ``applied``, or ``already`` when the tree is there (a second Apply is not an error)."""
    from flow_sdk.builtin.tag import Tag  # noqa: PLC0415
    from flow_sdk.stream_inbox import tag_management  # noqa: PLC0415
    from flow_sdk.stream_inbox.message_tags import retag_as_classification  # noqa: PLC0415

    if change.op == "added":
        existing = await _tag(change.tag)
        if existing is not None:
            if change.color and not existing.color:   # made before colours were picked: take the one shown
                existing.color = change.color
                await existing.save()
            return "already"
        await Tag(name=change.tag, title=change.tag.rsplit(".", 1)[-1], description=change.meaning,
                  color=change.color, stream_inbox=True).save()
    elif change.op == "updated":
        tag = await _tag(change.tag)
        if tag is None:
            raise ValueError(f"{change.tag} is not in the tag tree, so its meaning cannot be updated.")
        if tag.description == change.meaning:
            return "already"
        tag.description = change.meaning
        await tag.save()
    elif change.op == "moved":
        old = await _tag(change.was or "")
        if old is None:
            if await _tag(change.tag) is not None:
                return "already"
            raise ValueError(f"{change.was} is not in the tag tree, so it cannot be moved.")
        # A tag moves with everything under it: rename matches one exact name, so each child follows.
        under = [t for t in await Tag.get_all({"deprecated": False}) if t.name != old.name and tag_is_within(t.name, old.name)]
        await tag_management.rename(old, {"name": change.tag})
        for child in sorted(under, key=lambda t: t.name):
            await tag_management.rename(child, {"name": change.tag + child.name[len(old.name):]})
    else:
        tag = await _tag(change.tag)
        if tag is None:
            return "already"
        if change.merged_into:
            if await _tag(change.merged_into) is None:
                raise ValueError(f"{change.tag} is merged into {change.merged_into}, which is not in the tag tree.")
            messages, _ = await tag_management._affected(tag)
            for message in messages:
                await retag_as_classification(str(message.id), add=[change.merged_into], remove=[tag.name], rules=rules)
        await tag_management.delete(tag)
    return "applied"


def _values():
    """Where this instance keeps the proposals its runs handed in."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    from flow_sdk.values import store_of  # noqa: PLC0415

    return store_of(get_instance_settings().instance_dir)


async def problems(value: StreamInboxClassification) -> list[str]:
    """Why ``value`` could not be applied to the tag tree as it is now -- [] when it could. What the
    value's own schema cannot know: which tags exist."""
    from flow_sdk.stream_inbox.message_tags import ontology  # noqa: PLC0415

    known = {d["name"] for d in await ontology()}
    made = {c.tag for c in value.tree_changes if c.op in ("added", "moved")}
    out = []
    for change in value.tree_changes:
        if change.op in ("updated", "removed") and change.tag not in known:
            out.append(f"tree change {change.op} {change.tag}: no such tag in the tree")
        if change.op == "moved" and change.was not in known:
            out.append(f"tree change moved {change.tag}: its old name {change.was} is not in the tree")
        if change.op == "added" and change.tag in known:
            out.append(f"tree change added {change.tag}: the tag already exists")
        if change.merged_into and change.merged_into not in known | made:
            out.append(f"tree change removed {change.tag}: {change.merged_into} is neither in the tree nor made by this value")
    out += [f"{row.title!r}: proposed {tag} is neither in the tree nor added by this value"
            for row in value.conversations for tag in row.proposed if tag not in known | made]
    return out


#: The contrast-tested entity palette (``ui/src/lib/color-palette.ts``), spread so consecutive picks look apart.
_PALETTE = ("#dc2626", "#65a30d", "#0284c7", "#db2777", "#d97706", "#059669", "#6366f1", "#64748b", "#ea580c",
            "#16a34a", "#3b82f6", "#e11d48", "#a16207", "#0d9488", "#8b5cf6", "#0891b2", "#c026d3")


def review_app() -> Path:
    """The nano-app a proposal is reviewed and applied in: one HTML file, shipped beside the classifier skill."""
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

    return flowpad_assistant_project_root() / ".claude" / "skills" / "stream-inbox-classifier" / "classification-review.html"


async def _with_colors(value: StreamInboxClassification) -> StreamInboxClassification:
    """``value`` with a colour on every tag it adds: one the tree does not use yet. Chosen once, here, so what a
    person sees before applying is what is applied."""
    if all(change.color for change in value.tree_changes if change.op == "added"):
        return value
    from flow_sdk.builtin.tag import Tag  # noqa: PLC0415

    used = {(t.color or "").lower() for t in await Tag.get_all({"deprecated": False})} | {c.color for c in value.tree_changes}
    free = iter([hex_ for hex_ in _PALETTE if hex_ not in used] or _PALETTE)
    changes = [c.model_copy(update={"color": next(free, _PALETTE[0])}) if c.op == "added" and not c.color else c
               for c in value.tree_changes]
    return value.model_copy(update={"tree_changes": changes})


async def submit(value: StreamInboxClassification) -> str:
    """A run hands in its proposal: kept on this instance, and posted as the classifier automation's APP
    MESSAGE -- the review nano-app opened on the proposal, so it is read and applied in the conversation
    (its arrival is the one notification). Answers the value's reference -- what the run returns, since the
    value itself is bigger than a block may return."""
    from flow_sdk.app.automation_message import post_app_message  # noqa: PLC0415
    from flow_sdk.schema.data_spec.automation_spec import AutomationRef  # noqa: PLC0415
    from flow_sdk.stream_inbox.message_tags import classifier  # noqa: PLC0415
    from flow_sdk.values import save_value  # noqa: PLC0415

    value = await _with_colors(value)
    ref = save_value(value, _values())
    rule = await classifier()
    if rule is not None:
        changing = sum(row.action != "keep" for row in value.conversations)
        await post_app_message(
            AutomationRef(trigger_id=str(rule.id), name=rule.name or ""), review_app().read_text(encoding="utf-8"), value,
            status="needs_review",
            data={"conversations": len(value.conversations), "changing": changing, "tag_changes": len(value.tree_changes)})
    return ref


def submitted(ref: str) -> StreamInboxClassification:
    """The proposal a run handed in under ``ref``; ``LookupError`` when this instance does not hold it."""
    from flow_sdk.values import resolve_ref  # noqa: PLC0415

    return resolve_ref(ref, _values())


async def _truth_row(message, tag: str, source: str) -> dict:
    """``message`` belongs under ``tag`` ('' = no tag fits): its ground-truth row, keyed by the message."""
    from flow_sdk.stream_inbox.message_subject import message_state  # noqa: PLC0415
    from flow_sdk.stream_inbox.message_tags import message_context  # noqa: PLC0415

    # ``message_state``: a person applied this by hand, so a message they sent themselves is labelled too.
    return {
        "key": str(message.id),
        "kind": "eval",
        "input": (await message_context(message_state(message))).model_dump(mode="json"),
        "ground_truth": {"tag": tag},
        "data": {"source": source, "conversation_id": str(getattr(message, "conversation_id", "") or "")},
    }


async def truth() -> dict:
    """``{dataset_id, tags: {message id: confirmed tag}}`` -- '' is "no tag fits"; no dataset before the first row."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

    folder = GROUND_TRUTH.folder()
    if not (folder / "dataset.json").is_file():
        return {"dataset_id": None, "tags": {}}
    indexed = await GROUND_TRUTH.indexed()
    held = Dataset.at(folder)
    tags = {row.name: ((held.row(row.name).get("ground_truth") or {}).get("tag") or "") for row in rows(folder)}
    return {"dataset_id": str(indexed.id) if indexed is not None else None, "tags": tags}


def moderated(message) -> None:
    """A person changed a message's tags: when it is labelled, its ground truth follows (in the background).
    One stat for the usual case -- a message nobody labelled."""
    if message is None or not (GROUND_TRUTH.folder() / ROWS_DIR / str(message.id)).is_dir():
        return
    from flow_sdk.stream_inbox.message_tags import settings  # noqa: PLC0415

    mine = tags_under(message.tags, settings().root)

    async def follow():
        await GROUND_TRUTH.put_many([await _truth_row(message, mine[0] if mine else "", "person")])

    spawn(follow())


async def apply(value: StreamInboxClassification, *, conversations: Optional[list[str]] = None, tree: bool = True) -> dict:
    """Make the proposal real for ``conversations`` (ids; None = every row) and, with ``tree``, every tree
    change. A row whose tag a tree change adds or moves brings that change with it, tree or not."""
    from flow_sdk.stream_inbox.message_tags import _rules, ontology, retag_as_classification  # noqa: PLC0415

    picked = [r for r in value.conversations if conversations is None or r.conversation_id in conversations]
    needed = {tag for row in picked for tag in row.proposed}
    changes = [c for c in value.tree_changes if tree or (c.op in ("added", "moved") and c.tag in needed)]
    rules = await _rules()   # one read for the whole apply: the rule set does not change under it
    done = {c.tag: await _apply_change(c, rules) for c in sorted(changes, key=lambda c: _ORDER[c.op])}
    known = {d["name"] for d in await ontology()}
    applied, failed, truths = [], {}, []
    for row in picked:
        missing = [tag for tag in row.proposed if tag not in known]
        message = None if missing else await retag_as_classification(
            row.message_id, add=row.proposed, rules=rules,
            remove=lambda m, _s, keep=row.proposed: [t for t in tags_under(m.tags, value.root) if t not in keep])
        if message is None:
            failed[row.conversation_id] = f"{', '.join(missing)} is not in the tag tree." if missing else "The message is gone."
            continue
        applied.append(row.conversation_id)
        truths.append(await _truth_row(message, row.proposed[0] if row.proposed else "", "auto"))
    if truths:
        await GROUND_TRUTH.put_many(truths)
    return {"applied": applied, "failed": failed, "tree": done}

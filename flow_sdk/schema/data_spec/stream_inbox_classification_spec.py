"""The result of an auto-classifier run over Stream Inbox conversations (the ``stream-inbox-classifier`` skill).

A PROPOSAL: the run writes nothing. Each conversation says the tags it had and the tags it should
have; the tag tree's own changes ride beside them. A person applies rows and tree changes; what was
applied is read from the messages, never stored back here.
"""

from __future__ import annotations

from datetime import date
from typing import ClassVar, Literal, Optional

from pydantic import model_validator

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.tags.grammar import tag_is_within


def tags_under(tags, root: str) -> list[str]:
    """The tags of ``tags`` that sit under ``root`` -- the root itself is the tree, not a tag of it."""
    return [tag for tag in tags if tag != root and tag_is_within(tag, root)]


def action_of(before, proposed) -> str:
    """What a row does, read off its two tag lists: it is derived, never chosen."""
    had, has = set(before), set(proposed)
    return "keep" if had == has else "apply" if not had else "remove" if not has else "change"


class TagRequest(DataSpec):
    """A new tag a conversation's agent asked the main agent for, and the answer it got."""

    tag: str
    meaning: str
    answer: Literal["approved", "use_existing"]
    use: Optional[str] = None

    @model_validator(mode="after")
    def _answer_names_its_tag(self) -> "TagRequest":
        if (self.answer == "use_existing") != bool(self.use):
            raise ValueError("`use` names the existing tag of a `use_existing` answer, and only of that one")
        return self


class TagValidation(DataSpec):
    """The decision model's own reading of a row's message against the tag tree as the run would leave it:
    the tag it ``detected`` ('' = none), and whether that is the row's proposed tag."""

    detected: str = ""
    ok: bool


class ConversationTagging(DataSpec):
    """One conversation: the tags its latest message had, and the tags proposed for it."""

    spec_kind: ClassVar[str] = "stream_inbox.classification.conversation"

    conversation_id: str
    message_id: str
    title: str
    before: list[str] = []
    proposed: list[str] = []
    action: Literal["keep", "apply", "change", "remove"]
    reason: str
    asked: Optional[TagRequest] = None
    validation: Optional[TagValidation] = None

    @model_validator(mode="after")
    def _action_says_what_changed(self) -> "ConversationTagging":
        expected = action_of(self.before, self.proposed)
        if self.action != expected:
            raise ValueError(f"action {self.action!r} does not match before {sorted(self.before)} -> proposed {sorted(self.proposed)}: it is {expected!r}")
        return self


class TagTreeChange(DataSpec):
    """One change to the tag tree. ``tag`` is the full name AFTER the change (a removed tag: its name)."""

    spec_kind: ClassVar[str] = "stream_inbox.classification.tree_change"

    op: Literal["added", "updated", "moved", "removed"]
    tag: str
    was: Optional[str] = None
    meaning: Optional[str] = None
    color: Optional[str] = None
    merged_into: Optional[str] = None
    reason: str
    asked_by: int = 0

    @model_validator(mode="after")
    def _op_carries_its_facts(self) -> "TagTreeChange":
        if self.op in ("added", "updated") and not self.meaning:
            raise ValueError(f"an {self.op} tag says its meaning")
        if self.op in ("updated", "moved") and not self.was:
            raise ValueError(f"`was` holds the old {'meaning' if self.op == 'updated' else 'name'} of an {self.op} tag")
        if self.op == "moved" and self.was == self.tag:
            raise ValueError("a moved tag has a new name")
        if self.merged_into and self.op != "removed":
            raise ValueError("only a removed tag is merged into another")
        return self


class StreamInboxClassification(DataSpec):
    """Conversation x tag, as one run proposes it, with the tag tree changes it relies on."""

    spec_kind: ClassVar[str] = "stream_inbox.classification"

    root: str = "stream_inbox"
    since: Optional[date] = None
    until: Optional[date] = None
    conversations: list[ConversationTagging] = []
    tree_changes: list[TagTreeChange] = []

    @model_validator(mode="after")
    def _hangs_together(self) -> "StreamInboxClassification":
        names = [change.tag for change in self.tree_changes]
        if len(names) != len(set(names)):
            raise ValueError("a tag has one tree change")
        gone = {c.tag for c in self.tree_changes if c.op == "removed"} | {c.was for c in self.tree_changes if c.op == "moved"}
        seen: set[str] = set()
        for change in self.tree_changes:
            names = list(filter(None, (change.tag, change.merged_into, change.was if change.op == "moved" else None)))
            for name in set(names) - set(tags_under(names, self.root)):
                raise ValueError(f"{name!r} is not a tag under {self.root!r}")
            if change.merged_into in gone:
                raise ValueError(f"{change.tag!r} is merged into {change.merged_into!r}, which this run removes or moves")
        for row in self.conversations:
            if row.conversation_id in seen:
                raise ValueError(f"conversation {row.conversation_id} appears twice")
            seen.add(row.conversation_id)
            for name in set(row.proposed) - set(tags_under(row.proposed, self.root)):
                raise ValueError(f"{row.title!r}: proposed {name!r} is not a tag under {self.root!r}")
            for name in gone.intersection(row.proposed):
                raise ValueError(f"{row.title!r}: proposed {name!r} is removed or moved by this run")
        return self

"""``Choice`` / ``ChoiceSet`` — what a provider says you can pick, as a value.

The config form asks three providers for values a person cannot produce from memory: a
shared-drive id, a Slack channel id, a bucket name. These are the answer to "what can
this credential actually see?" for ONE config field — flat, never a tree.

**A refusal is data, not an exception.** Listing is a live provider call and it fails in
ordinary ways: no connection, a scope the consent screen never asked for, a project id
nobody set. Every one of those means the same thing to the person filling the form —
*type it instead* — so a `ChoiceSet` carries an empty `items` and the sentence saying
why, and the field falls back to a text input. A raised exception would make the form
show an error where it should show a fallback.
"""

from __future__ import annotations

from typing import ClassVar

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec


class Choice(DataSpec):
    """One thing that can be picked. Frozen; a value is a value."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "ingest.choice"

    #: What gets stored, and what the driver keys on. A renamed channel keeps its id.
    id: str
    #: What a person reads. Equal to ``id`` when the provider has no separate name — a
    #: GCS bucket's name IS its id — and the form collapses that case back to a plain
    #: string so no provider grows a shape it did not have.
    name: str = ""
    #: One short qualifier under the name: ``private``, ``us-central1``. Never required.
    detail: str = ""


class ChoiceSet(DataSpec):
    """One field's offer: what can be picked, or why nothing can."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "ingest.choice_set"

    items: list[Choice] = []
    #: Why ``items`` is empty, when it is — rendered beside the text input the field
    #: falls back to. Empty when the list is the whole answer.
    detail: str = ""


__all__ = ["Choice", "ChoiceSet"]

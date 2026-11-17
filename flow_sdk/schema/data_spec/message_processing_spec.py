"""Private, durable processing state of a message; its tags remain Entity.tags."""
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec


class TagAssignment(DataSpec):
    source: Literal["manual", "classification", "automation"] = "manual"
    trigger_id: str | None = None
    run_id: str | None = None


class MessageAutomationEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    trigger_id: str
    automation_name: str = ""
    #: The tag that queued the rule. Empty on the classifier's own entry: it is what gives the tags.
    tag: str
    status: Literal["queued", "running", "succeeded", "failed", "skipped", "cancelled", "interrupted"] = "queued"
    run_id: str | None = None
    error: str = ""


class MessageProcessing(BaseModel):
    # This is a transactional row snapshot, not an immutable FlowCall input spec.
    model_config = ConfigDict(extra="forbid")
    spec_kind: ClassVar[str] = "stream_inbox.message.processing"
    classification: Literal["pending", "running", "succeeded", "failed", "skipped"] = "skipped"
    classification_error: str = ""
    #: A person asked for this classification ("Classify now"): it runs whatever the switch says.
    classification_forced: bool = False
    assignments: dict[str, TagAssignment] = Field(default_factory=dict)
    queue: list[MessageAutomationEntry] = Field(default_factory=list)
    # A classifier finishing after a person's removal must not restore that tag.
    suppressed_tags: list[str] = Field(default_factory=list)


class MessageClassificationSettings(DataSpec):
    """How messages are classified. Whether they are is the classifier automation's own switch."""

    include_flow_tags: bool = False
    #: The tag tree a message is classified into: every tag within it is an option.
    root: str = "stream_inbox"

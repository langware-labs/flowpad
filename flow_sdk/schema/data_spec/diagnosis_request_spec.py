"""The shapes a diagnosis request travels in: opening one, funding it, and one run written into it.

``DiagnosisRunSpec`` is the wire body of the hub's ``submit`` (``DiagnosisRun`` there -- the hub pins a
released SDK, so it mirrors the field set; ``test_flowpad_diagnosis_model`` pins the hub's half).
"""

from typing import ClassVar, Optional

from pydantic import ConfigDict, Field, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec

#: The write window and the run size the hub clamps to; mirrored so a bad value fails HERE, early.
DEFAULT_WRITE_HOURS = 48
MAX_WRITE_HOURS = 7 * 24
DEFAULT_MAX_RUN_MB = 2
MAX_MAX_RUN_MB = 10
#: Largest single attachment the owner may send (decoded bytes) -- it rides one JSON body here.
MAX_ATTACHMENT_MB = 20


class DiagnosisFundingSpec(DataSpec):
    """Where the runner's LLM budget comes from: a hub endpoint the owner may allocate from, OR a key
    stored on this computer -- which is uploaded to the hub as an endpoint and spent on the RUNNER's
    machine. Exactly one of the two."""

    spec_kind: ClassVar[str] = "diagnosis.funding"
    model_config = ConfigDict(frozen=True)

    source_typeid: str = ""
    local_key_provider: str = ""
    cost_usd_total: float = Field(gt=0)
    hours: int = Field(default=DEFAULT_WRITE_HOURS, ge=1, le=MAX_WRITE_HOURS)
    model: str = ""

    @model_validator(mode="after")
    def _one_source(self):
        if bool(self.source_typeid) == bool(self.local_key_provider):
            raise ValueError("name exactly one of source_typeid and local_key_provider")
        return self


class DiagnosisAttachmentSpec(DataSpec):
    """One thing the owner sends the runner: a file from their computer (``file_name`` +
    ``content_b64``), or a Flowpad asset by typeid (``asset_typeid`` -- a skill lands in the run's
    ``.claude/skills``; any other asset as a file, zipped when it is a folder). Exactly one."""

    spec_kind: ClassVar[str] = "diagnosis.attachment"
    model_config = ConfigDict(frozen=True)

    file_name: str = ""
    content_b64: str = Field(default="", max_length=MAX_ATTACHMENT_MB * 1024 * 1024 * 4 // 3 + 4)
    asset_typeid: str = ""

    @model_validator(mode="after")
    def _one_kind(self):
        if bool(self.file_name) == bool(self.asset_typeid):
            raise ValueError("name exactly one of file_name and asset_typeid")
        if self.file_name and ("/" in self.file_name or "\\" in self.file_name or self.file_name in (".", "..")):
            raise ValueError("file_name must be a bare file name")
        return self


class DiagnosisRequestOpenSpec(DataSpec):
    """``POST /graph/diagnosis_request/open`` -- what the owner fills in."""

    spec_kind: ClassVar[str] = "diagnosis.request.open"
    model_config = ConfigDict(frozen=True)

    instructions: str = ""
    #: The project the request is listed under; empty for a user-level one.
    project_id: str = ""
    write_hours: int = Field(default=DEFAULT_WRITE_HOURS, ge=1, le=MAX_WRITE_HOURS)
    max_run_mb: int = Field(default=DEFAULT_MAX_RUN_MB, ge=1, le=MAX_MAX_RUN_MB)
    funding: Optional[DiagnosisFundingSpec] = None
    attachments: list[DiagnosisAttachmentSpec] = Field(default_factory=list)


class DiagnosisRunSpec(DataSpec):
    """One run of ``flow diagnose <id>``: the diagnosis it recorded, and the files it attached."""

    spec_kind: ClassVar[str] = "diagnosis.run"
    model_config = ConfigDict(frozen=True)

    title: Optional[str] = None
    symptoms: Optional[str] = None
    rca: Optional[str] = None
    fix: Optional[str] = None
    summary: Optional[str] = None
    user_report: Optional[str] = None
    reported_by: Optional[str] = None
    occurred_at: Optional[str] = None
    os: Optional[str] = None
    app_version: Optional[str] = None
    #: name -> text. Log excerpts, the agent's transcript -- whatever the instructions asked for.
    files: dict[str, str] = Field(default_factory=dict)

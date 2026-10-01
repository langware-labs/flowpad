"""What a project needs before it runs, as values — ``flow project setup``'s requirements.

One requirement per thing a person has to provide:

* ``oauth`` — a connection a data source acts through (``auth.connector``), with the union of the
  scopes every requester needs;
* ``pack`` — a credential (a Credential) the project declares or a data source names, with the
  values it still lacks in development;
* ``gap`` — something the project needs that nothing declares how to provide. Reported, never run.

Names and presence only: no value ever appears in these shapes.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec

REQUIREMENT_OAUTH = "oauth"
REQUIREMENT_PACK = "pack"
REQUIREMENT_GAP = "gap"


def input_name(credential: str, env_var: str) -> str:
    """The wizard value a typed ``env_var`` of ``credential`` is bound to. It reaches
    ``flow credentials set --from-inputs`` as ``FLOWPAD_WIZARD_INPUT_<CREDENTIAL>__<VAR>``."""
    return f"{credential}__{env_var}"


class SetupVarSpec(DataSpec):
    """One value a pack needs, as the person is asked for it."""

    spec_kind: ClassVar[str] = "project.setup.var"
    model_config = ConfigDict(frozen=True)

    env_var: str
    label: str = ""
    hint: str = ""
    help_url: str = ""
    pattern: str = ""
    secret: bool = True
    #: The value is a file's content (a key file) — asked with a file picker, kept as a file.
    file: bool = False
    present: bool = False


class SetupRequirementSpec(DataSpec):
    """One thing to set up, and who needs it."""

    spec_kind: ClassVar[str] = "project.setup.requirement"
    model_config = ConfigDict(frozen=True)

    #: ``oauth`` / ``pack`` / ``gap``.
    kind: str
    #: The provider (oauth) or the credential's name (pack).
    name: str
    title: str = ""
    #: oauth: every scope a requester needs.
    scopes: list[str] = []
    #: pack: the values it needs in development.
    vars: list[SetupVarSpec] = []
    #: pack: how an agent obtains and stores the values (``CredentialSpec.setup``); empty = no AI Assist.
    setup: str = ""
    #: pack: how long an agent following ``setup`` gets (``CredentialSpec.setup_timeout_seconds``).
    setup_timeout_seconds: Optional[float] = None
    help_url: str = ""
    #: pack: declared in the project or user scope — else it is added from its shipped template.
    declared: bool = True
    #: Known to hold already. ``None`` when only running its check can tell (a connection).
    satisfied: Optional[bool] = None
    #: The data sources (and ``project``, for a pack the project declares itself) that need it.
    used_by: list[str] = []
    #: Why a gap is one, or what is off about a requirement (a pack with no setup instructions).
    note: str = ""

    @property
    def missing(self) -> list[SetupVarSpec]:
        return [v for v in self.vars if not v.present]


class ProjectReadinessSpec(DataSpec):
    """Is a project ready to run here — every MUST value set, every connection it needs held?"""

    spec_kind: ClassVar[str] = "project.setup.readiness"
    model_config = ConfigDict(frozen=True)

    project_id: str
    ready: bool
    #: What still needs someone — what the setup wizard walks through.
    to_do: list[SetupRequirementSpec] = []
    #: What no credential declares: reported, never runnable (``note`` says what to add).
    gaps: list[SetupRequirementSpec] = []

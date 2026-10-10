"""What a project needs before it runs, as values — ``flow project setup``'s requirements.

One requirement per thing a person has to provide:

* ``pack`` — a credential (a Credential) the project declares or a data source names: an ``env`` one with the
  values it still lacks in development, or an ``oauth`` one (a connection a source acts through, declared with
  the union of the scopes its requesters need) that is not connected yet;
* ``gap`` — something the project needs that nothing declares how to provide. Reported, never run.

Names and presence only: no value ever appears in these shapes.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.asset_setup_spec import SetupSkipSpec
from flow_sdk.schema.data_spec.spec import DataSpec

REQUIREMENT_PACK = "pack"
REQUIREMENT_GAP = "gap"
#: A required ``flow.json`` dependency that is not on this machine.
REQUIREMENT_DEPENDENCY = "dependency"
#: A data source of the project that is still in setup (its verify found it not set up). Readiness only:
#: the setup tree sets it up as its own node (``core/setup/derive``).
REQUIREMENT_SOURCE = "source"
#: A web app of the project whose dev server does not answer. Readiness only, like ``source``.
REQUIREMENT_WEBAPP = "webapp"


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

    #: ``pack`` / ``gap`` / ``dependency`` / ``source`` / ``webapp``.
    kind: str
    #: The credential's name (pack), the dependency's, the source's or the web app's.
    name: str
    title: str = ""
    #: pack: what the credential is needed for, in one line, and the full reason (``CredentialSpec``).
    needed_for: str = ""
    justification: str = ""
    #: The record this requirement IS (a Credential, DataSource, WebApp; the Project for a dependency).
    typeid: str = ""
    #: pack: ``env`` (values to provide) or ``oauth`` (a provider's grant to connect).
    credential_kind: str = "env"
    #: pack, oauth: the connection provider.
    provider: str = ""
    #: pack, oauth: every scope a requester needs.
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
    #: The project does not work without it. ``False``: it turns a feature on (an env credential with only
    #: OPTIONAL values, a dependency flow.json marks optional) — listed, never counted toward "Setup required".
    required: bool = True
    #: Skipped in this project's setup on this machine — read off its record (``core/setup/skip_mark``).
    skipped: Optional[SetupSkipSpec] = None
    #: Whether "Skip → Always" can remove it from the project (its asset is the project's own), and if not, why.
    can_skip_always: bool = False
    why_not_always: str = ""

    @property
    def missing(self) -> list[SetupVarSpec]:
        return [v for v in self.vars if not v.present]

    @property
    def is_oauth(self) -> bool:
        return self.kind == REQUIREMENT_PACK and self.credential_kind == "oauth"


class ProjectReadinessSpec(DataSpec):
    """Is a project ready to run here — every MUST value set, every connection it needs held?"""

    spec_kind: ClassVar[str] = "project.setup.readiness"
    model_config = ConfigDict(frozen=True)

    project_id: str
    ready: bool
    #: What still needs someone — what the setup wizard walks through. Required, and not skipped.
    to_do: list[SetupRequirementSpec] = []
    #: What turns a feature on and is not set up yet — listed, never counted.
    optional: list[SetupRequirementSpec] = []
    #: What a person skipped on this machine (required or not) — listed with an Undo.
    skipped: list[SetupRequirementSpec] = []
    #: What no credential declares: reported, never runnable (``note`` says what to add).
    gaps: list[SetupRequirementSpec] = []

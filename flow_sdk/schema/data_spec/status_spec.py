"""The status record: WHAT is on this machine, before anyone asks what pays.

One shape per fact, one writer per fact. Funding (``cli_drivers/llm_source.py``) is a layer
ON TOP of this record and never re-derives a field of it; the UI renders it and derives
nothing. Each enum is the ONLY vocabulary for its fact -- a surface that needs a word maps
one of these values, it does not invent a fifth state.
"""

from __future__ import annotations

from enum import StrEnum
from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class InstallState(StrEnum):
    """Is the harness's CLI on this machine."""

    INSTALLED = "installed"
    NOT_INSTALLED = "not_installed"
    #: A ``python -m`` harness that ships with Flowpad (deepagents): nothing to install.
    BUILT_IN = "built_in"
    #: The discovery sweep has not finished yet -- the only time "we do not know" is true.
    UNKNOWN = "unknown"


class LoginState(StrEnum):
    """The harness's OWN login -- never inferred from what funds it."""

    SIGNED_IN = "signed_in"
    SIGNED_OUT = "signed_out"
    ERROR = "error"
    SIGNING_IN = "signing_in"
    #: Installed, and no probe has decided yet. Never presumed to be signed in.
    NOT_CHECKED = "not_checked"
    #: There is no login to have: the CLI is not installed, or the harness has no account
    #: of its own (it spends a key or a hub endpoint).
    N_A = "n_a"


class HubLogin(StrEnum):
    """This box's FlowPad account, from the hub's own answer to "who am I"."""

    SIGNED_IN = "signed_in"
    SIGNED_OUT = "signed_out"
    SIGNING_IN = "signing_in"
    #: The hub refused the stored credential.
    REJECTED = "rejected"
    #: A credential is stored but the hub could not be reached to confirm it.
    OFFLINE = "offline"


class AccountSpec(DataSpec):
    """Who is signed in and on what plan, when the vendor says. Empty when it does not."""

    spec_kind: ClassVar[str] = "status.account"

    identity: str = ""
    plan: str = ""


class HarnessStatusSpec(DataSpec):
    """One harness: what it is, whether it is here, whether it is signed in."""

    spec_kind: ClassVar[str] = "status.harness"

    #: The capability kind (``harness.claude.cli``) -- the key every other record uses.
    kind: str
    #: The driver name (``claude``), what an agent.json and a spawn name it by.
    worker_type: str
    label: str
    icon: str = ""
    install: InstallState
    version: str = ""
    path: str = ""
    login: LoginState
    #: When a probe established ``login`` (ISO-8601); empty when none ever has.
    login_checked_at: str = ""
    login_message: str = ""
    account: AccountSpec = AccountSpec()
    #: Whether the harness has an account of its own to sign in to.
    has_device_login: bool
    #: The LLM key providers this harness can spend (``openrouter``, ``anthropic``...).
    key_providers: tuple[str, ...] = ()
    install_command: str = ""
    homepage_url: str = ""


class KeyStatusSpec(DataSpec):
    """One LLM-provider key slot: whether a key is stored. Never the value."""

    spec_kind: ClassVar[str] = "status.key"

    provider: str
    stored: bool
    created_at: str = ""


class HubStatusSpec(DataSpec):
    """This box's FlowPad account."""

    spec_kind: ClassVar[str] = "status.hub"

    login: HubLogin
    #: The hub user's email, when signed in.
    email: str = ""
    user_typeid: str = ""
    #: Why the hub is not signed in, when it said.
    error: str = ""


class StatusSpec(DataSpec):
    """Everything this box has that could matter to running an agent."""

    spec_kind: ClassVar[str] = "status"

    harnesses: tuple[HarnessStatusSpec, ...]
    keys: tuple[KeyStatusSpec, ...]
    hub: HubStatusSpec
    #: The capability kind of the user's default harness, or empty when none is set.
    default_harness: str = ""

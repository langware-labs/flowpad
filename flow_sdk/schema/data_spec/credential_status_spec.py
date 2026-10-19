"""What the Connections screen needs to know about declared credentials.

Names and presence only — no value ever appears in these shapes.
"""
from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.asset_setup_spec import SetupSkipSpec
from flow_sdk.schema.data_spec.compute_op_spec import CliOp
from flow_sdk.schema.data_spec.credential_contract import (
    DEFAULT_ENVIRONMENT,
    CredentialRequirement,
    CredentialVarKind,
    Requirement,
)
from flow_sdk.schema.data_spec.spec import DataSpec


class CredentialWaySpec(DataSpec):
    """How a ONE_OF way of several variables is offered: its title and one line under it. A way of one variable
    is offered by that variable's own label and hint."""

    model_config = ConfigDict(frozen=True)

    label: str = ""
    hint: str = ""


class CredentialVarStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    env_var: str
    label: str = ""
    hint: str = ""
    placeholder: str = ""
    pattern: str = ""
    help_url: str = ""
    secret: bool = True
    #: What THIS deployment needs: the var's own ``required``, raised to ``MUST`` when the
    #: deployment requires it beyond the credential (``DeploymentSecretsSpec.require``).
    required: Requirement = CredentialRequirement.MUST
    kind: CredentialVarKind = CredentialVarKind.TEXT
    #: The store this deployment keeps the variable in: ``env`` / ``vault`` / a remote store type —
    #: ``cli`` for a sign-in a command-line tool holds, ``connection`` for an oauth grant.
    store: str = "env"
    #: A value exists in that store (cli: its check passed on this computer; oauth: the grant is held and
    #: covers ``scopes``).
    present: bool = False
    #: oauth: the provider whose grant this way is, and the scopes it must cover.
    provider: str = ""
    scopes: list[str] = []
    #: cli: the command a person runs on this computer to sign in.
    login: str = ""
    #: cli: the declaration's own ``login`` / ``check`` (every OS) — what an edit of the credential sends back.
    login_spec: Optional[CliOp] = None
    check_spec: Optional[CliOp] = None
    #: Where a value was found at all: ``env`` / ``vault`` / the remote store type / None.
    found_in: Optional[str] = None
    #: ``missing`` (no value anywhere), ``wrong-store`` (a value in the other local store) or
    #: ``unreachable`` (a remote store that could not be asked).
    warning: Optional[str] = None
    #: The typeid of the project credential overriding this user one, if any.
    shadowed_by: Optional[str] = None
    #: ONE_OF: the way this variable belongs to (``CredentialVarSpec.way``); empty = its own name.
    way: str = ""

    @property
    def is_must(self) -> bool:
        return self.required is CredentialRequirement.MUST

    @property
    def is_one_of(self) -> bool:
        return self.required is CredentialRequirement.ONE_OF

    @property
    def holds_value(self) -> bool:
        """A store keeps a value for it — not a sign-in (``cli``) or a grant (``oauth``), which live elsewhere."""
        return self.kind not in (CredentialVarKind.CLI, CredentialVarKind.OAUTH)


def ways(vars: Mapping[str, Any]) -> dict[str, list[str]]:
    """The ONE_OF ways of ``vars`` in declaration order: ``{way: [member var names]}``. A var's way is its
    declared ``way``, else its own name. ``vars`` maps a name to anything with ``is_one_of`` and ``way``."""
    out: dict[str, list[str]] = {}
    for name, v in vars.items():
        if v.is_one_of:
            out.setdefault(getattr(v, "way", "") or name, []).append(name)
    return out


def way_named(vars: Mapping[str, Any], name: str, grouped: Optional[dict[str, list[str]]] = None) -> str:
    """The way ``name`` says — a way's own name, or a member var's name (the alias a choice stored before ways
    had names); ``""`` when it names neither. ``grouped``: ``ways(vars)``, when the caller has it already."""
    if not name:
        return ""
    if name in (ways(vars) if grouped is None else grouped):
        return name
    v = vars.get(name)
    return (getattr(v, "way", "") or name) if v is not None and v.is_one_of else ""


def way_order(vars: Mapping[str, Any], choice: str = "", grouped: Optional[dict[str, list[str]]] = None) -> list[str]:
    """Which way of a ONE_OF group is active — the order, said once: the way chosen here (``choice``, while it
    names a way or a member), else a stored value's way, then a grant's (``oauth``), then a tool's sign-in
    (``cli``), each in declaration order. Returns WAY names (:func:`ways`; ``grouped`` when already computed)."""
    grouped = ways(vars) if grouped is None else grouped
    chosen = way_named(vars, choice, grouped)
    if chosen:
        return [chosen]
    rank = {CredentialVarKind.OAUTH: 1, CredentialVarKind.CLI: 2}
    return sorted(grouped, key=lambda way: max(rank.get(vars[m].kind, 0) for m in grouped[way]))


def active_way(
    vars: Mapping[str, Any], choice: str, held: Callable[[str], bool], grouped: Optional[dict[str, list[str]]] = None
) -> str:
    """The active way: the chosen one (held or not), else the first in :func:`way_order` whose every member
    ``held`` (asked per VAR name) says is there; ``""`` when none is."""
    grouped = ways(vars) if grouped is None else grouped
    chosen = way_named(vars, choice, grouped)
    if chosen:
        return chosen
    return next((way for way in way_order(vars, grouped=grouped) if all(held(m) for m in grouped[way])), "")


def group_held(vars: list, choice: str = "") -> bool:
    """The ONE_OF rule, said once: no group, or every member of its active way (:func:`active_way`) present.
    ``vars`` are anything with ``env_var``, ``is_one_of``, ``kind``, ``way`` and ``present`` (a status row's,
    a setup requirement's)."""
    by_name = {v.env_var: v for v in vars}
    grouped = ways(by_name)
    if not grouped:
        return True
    active = active_way(by_name, choice, lambda name: by_name[name].present, grouped)
    return bool(active) and all(by_name[m].present for m in grouped[active])


class CredentialStatusRowSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    typeid: str
    name: str
    title: str = ""
    description: str = ""
    #: What it is needed for, in one line, and the full reason (``CredentialSpec``).
    needed_for: str = ""
    justification: str = ""
    icon_name: str = ""
    help_url: str = ""
    setup_wiki: str = ""
    #: How an agent obtains and stores the values (``CredentialSpec.setup``); empty = no AI Assist.
    setup: str = ""
    #: How long an agent following ``setup`` gets; ``None`` = the default.
    setup_timeout_seconds: Optional[float] = None
    scope: str
    project_id: Optional[str] = None
    #: The environment of the deployment these presences were read for.
    environment: str = DEFAULT_ENVIRONMENT
    #: Where that deployment keeps this credential: ``env`` / ``vault`` / a remote store type, or
    #: ``mixed`` when its variables are split (each var row says its own).
    value_store: str
    lm_provider: str = ""
    #: ``env`` (values are variables) or ``oauth`` (a provider's grant).
    kind: str = "env"
    #: oauth: the provider, the scopes the project needs, and those the held grant does not cover.
    provider: str = ""
    scopes: list[str] = []
    missing_scopes: list[str] = []
    #: Skipped in the project's setup on this machine (the record's ``setup_skipped``).
    setup_skipped: Optional[SetupSkipSpec] = None
    #: Where its folder is on this machine — what "Skip → Always" would remove.
    asset_ref: str = ""
    #: The ONE_OF way set up here (``Credential.chosen``); ``""`` when none is chosen yet.
    setup_choice: str = ""
    #: How each ONE_OF way of several variables is offered (``CredentialSpec.ways``).
    ways: dict[str, CredentialWaySpec] = {}
    #: ``connected`` (every MUST value present and one of the ONE_OF ones / the grant held and covering), ``partial`` (some values;
    #: a grant missing scopes), ``needs_reauth`` (oauth: the grant went stale) or ``missing``.
    state: str
    vars: list[CredentialVarStatusSpec] = []

    @property
    def missing(self) -> list[str]:
        """The variables still needed: every absent MUST, and a ONE_OF group's members while none is there."""
        held = group_held(self.vars, self.setup_choice)
        return [v.env_var for v in self.vars if not v.present and (v.is_must or (v.is_one_of and not held))]


class DetectedKeySpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    key: str
    line: int


class EnvFallbackStatusSpec(DataSpec):
    """A file the scope's env store falls back to — a project's declared ``env_files`` entry.
    Read, never written, so it has no ``blocked``."""

    model_config = ConfigDict(frozen=True)

    path: str
    #: As the project manifest declares it (``backend/.env``).
    extra_path: str
    exists: bool = False
    detected: list[DetectedKeySpec] = []


class ScopeFileStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    scope: str
    project_id: Optional[str] = None
    #: The environment this env file belongs to (``.env.local`` is ``development``).
    environment: str = DEFAULT_ENVIRONMENT
    path: Optional[str] = None
    exists: bool = False
    blocked: bool = False
    block_code: Optional[str] = None
    block_reason: Optional[str] = None
    detected: list[DetectedKeySpec] = []
    #: The files read after this one, in order (``development`` only).
    fallbacks: list[EnvFallbackStatusSpec] = []


class DeploymentChoiceSpec(DataSpec):
    """A deployment the Credentials screen can show values for."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str = ""
    environment: str = DEFAULT_ENVIRONMENT
    this_computer: bool = False


class CredentialsStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    project_id: Optional[str] = None
    #: The deployment this status was read for, and its environment.
    deployment_id: str = ""
    environment: str = DEFAULT_ENVIRONMENT
    #: Every deployment there is: this computer first.
    deployments: list[DeploymentChoiceSpec] = []
    vault_enabled: bool = False
    credentials: list[CredentialStatusRowSpec] = []
    files: list[ScopeFileStatusSpec] = []


class StoreForgottenSpec(DataSpec):
    """What deleting a credential did in ONE store. Names only."""

    model_config = ConfigDict(frozen=True)

    #: The store type: ``env_file`` / ``vault`` / ``gcp_secret_manager`` / ...
    type: str
    #: Where it is: a file path, a vault prefix, a secret project.
    where: str
    deleted: list[str] = []
    #: Still there: the store refused or failed to remove them.
    kept: list[str] = []
    #: Why the store could not be checked at all; every name counts as kept.
    error: str = ""


class CredentialDeletedSpec(DataSpec):
    """The result of deleting a credential: removed only when no store still holds a value."""

    model_config = ConfigDict(frozen=True)

    removed: bool
    deleted: list[str] = []
    kept: list[str] = []
    stores: list[StoreForgottenSpec] = []


class LeftoverSpec(DataSpec):
    """A secret still stored somewhere it should not be. The name, never the value."""

    model_config = ConfigDict(frozen=True)

    store: str
    where: str
    name: str


class UncheckedSpec(DataSpec):
    """A store the sweep could not read: unchecked is not clean."""

    model_config = ConfigDict(frozen=True)

    store: str
    where: str
    error: str


class SweepSpec(DataSpec):
    """``flow credentials audit``: what is left of deleted credentials, projects, agents and deployments."""

    model_config = ConfigDict(frozen=True)

    clean: bool
    found: list[LeftoverSpec] = []
    unchecked: list[UncheckedSpec] = []
    checked: list[str] = []

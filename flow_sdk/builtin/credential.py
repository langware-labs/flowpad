"""Credential — a named set of environment variables, and the only way to
declare secrets.

Where the folder lives is the declaration's scope, using the asset scopes
Flowpad already has:

* ``<project>/agentic-assets/credential/<name>/`` — declared for that project.
* ``~/agentic-assets/credential/<name>/`` — declared for the user (every project
  on this machine).
* the shipped assistant project — ``system`` scope, a read-only TEMPLATE that
  declares nothing until it is added to one of the two scopes above.

Where the values live is never the credential's: each Deployment says it
(``DeploymentSecretsSpec``; ``credential_store.Placement``). The manifest is
value-free, structurally: every parse runs through ``assert_value_free``.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, FrozenSet, Optional

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.named_lookup import NameAmbiguous, NameNotFound
from flow_sdk.core.setup.skip_mark import SetupSkippable, write_projection
from flow_sdk.schema.data_spec.asset_setup_spec import SetupSkipSpec
from flow_sdk.schema.data_spec.credential_contract import SCOPE_PROJECT, SCOPE_SYSTEM, SCOPE_USER, CredentialKind
from flow_sdk.schema.data_spec.compute_op_spec import CliOp
from flow_sdk.schema.data_spec.credential_spec import CURRENT_SCHEMA, CredentialVarSpec
from flow_sdk.schema.data_spec.credential_status_spec import CredentialTestResultSpec
from flow_sdk.schema.data_spec.credential_status_spec import CredentialWaySpec
from flow_sdk.schema.data_spec.setup_stage_spec import SetupStageSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.secrets.requirements import SecretRequirements

if TYPE_CHECKING:
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.builtin.project import Project
    from flow_sdk.secrets import SecretStore


class CredentialNotFound(NameNotFound):
    """Neither the project nor the user scope declares a credential of that name."""

    message = "no credential named {name!r} in this project or the user scope"


class CredentialAmbiguous(NameAmbiguous):
    """More than one credential of that name in the scope that answered; ``candidates`` are typeids."""

    plural = "credentials"


#: The way of a ONE_OF group a person set up here (``Credential.setup_choice``).
CHOICE_FIELD = "setup_choice"
#: The last test run here (``Credential.test_result``).
TEST_FIELD = "test_result"


class Credential(SetupSkippable, Entity):
    """The ROW; its shape on disk is ``CredentialSpec`` (``TypeInfo.asset_spec``)."""

    projected_fields: ClassVar[FrozenSet[str]] = SetupSkippable.projected_fields | {CHOICE_FIELD, TEST_FIELD}
    projection_writer: ClassVar[str] = "core.setup.skip_mark.write_setup_skip / builtin.credential.write_setup_choice"

    type: str = APIField(default=EntityType.CREDENTIAL.value)

    # A folder-backed asset, so it OWNS its path. PRIVATE: the path is this
    # machine's and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    title: str = APIField(default="")
    description: str = APIField(default="")
    #: What it is needed for, in one line, and the full reason (``CredentialSpec``).
    needed_for: str = APIField(default="")
    justification: str = APIField(default="")
    icon_name: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    help_url: str = APIField(default="")
    setup_wiki: str = APIField(default="")
    setup_wizards: list[SetupStageSpec] = APIField(default_factory=list)
    #: How an agent obtains and stores the values (``CredentialSpec.setup``).
    setup: str = APIField(default="")
    #: How long an agent following ``setup`` gets (``CredentialSpec.setup_timeout_seconds``).
    setup_timeout_seconds: Optional[float] = APIField(default=None)
    #: The read-only check that the values work (``CredentialSpec.test``).
    test: Optional[CliOp] = APIField(default=None)
    lm_provider: str = APIField(default="")
    #: ``env`` (variables) or ``oauth`` (a provider's grant) — ``CredentialSpec.kind``.
    kind: CredentialKind = APIField(default=CredentialKind.ENV)
    #: oauth: the connection provider, and the scopes its grant must cover.
    provider: str = APIField(default="")
    scopes: list[str] = APIField(default_factory=list)
    optional_scopes: list[str] = APIField(default_factory=list)
    vars: dict[str, CredentialVarSpec] = APIField(default_factory=dict)
    #: How each ONE_OF way of several variables is offered (``CredentialSpec.ways``).
    ways: dict[str, CredentialWaySpec] = APIField(default_factory=dict)
    #: A root installed it (``CredentialSpec.derived``); else the project authored it.
    derived: bool = APIField(default=False)
    #: Skipped in this project's setup on THIS machine (``SetupSkipSpec``). PRIVATE: a skip is a person's choice
    #: here, never part of the declaration — the file and a share never carry it.
    setup_skipped: Optional[SetupSkipSpec] = APIField(None, sharing=Sharing.PRIVATE)
    #: The ONE_OF member a person set up on THIS machine (a sign-in way or a value way): while it
    #: names a declared member, that member alone decides the group, and it is the way a source is handed.
    #: PRIVATE and row-only, like ``setup_skipped`` — the declaration offers the ways, the person picks here.
    setup_choice: str = APIField(default="", sharing=Sharing.PRIVATE)
    #: The last ``test`` run on THIS machine (``credential_service.test_credential``). PRIVATE and row-only:
    #: whether a key worked here is this machine's fact, never part of the declaration.
    test_result: Optional[CredentialTestResultSpec] = APIField(None, sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True

    @property
    def is_oauth(self) -> bool:
        return self.kind is CredentialKind.OAUTH or str(self.kind) == CredentialKind.OAUTH.value

    @field_validator("vars", mode="before")
    @classmethod
    def _project_nested(cls, value: Any, info: Any) -> Any:
        """Read each nested entry field by field, dropping keys the model does not name.

        A row indexed by an earlier build can carry fields that no longer exist
        (``sod_name``). The manifest is still strict — ``CredentialSpec``
        rejects them on disk — but a stored row must stay readable, or one stale
        row fails every credential query.
        """
        if not isinstance(value, dict):
            return value
        known = set(CredentialVarSpec.model_fields)
        return {
            name: {k: v for k, v in spec.items() if k in known} if isinstance(spec, dict) else spec
            for name, spec in value.items()
        }

    @property
    def is_template(self) -> bool:
        """A shipped catalogue entry: copied into a scope, never injected itself."""
        return self.scope == SCOPE_SYSTEM

    @property
    def folder(self) -> Optional[Path]:
        """The credential's own folder on this machine; ``None`` for a row with no file."""
        if not self.asset_ref:
            return None
        ref = Path(self.asset_ref)
        return ref if ref.is_dir() else ref.parent

    def declared_test(self) -> Optional[CliOp]:
        """The ``test`` ``credential.json`` declares NOW. The file is the truth: an agent that just wrote a test
        runs it (and the page offers the fast lane) before any re-index reaches the row."""
        import json  # noqa: PLC0415

        folder = self.folder
        if folder is None:
            return self.test
        try:
            raw = json.loads((folder / "credential.json").read_text(encoding="utf-8")).get("test")
            return CliOp.model_validate(raw) if raw else None
        except (OSError, ValueError):
            return self.test

    def var_names(self) -> list[str]:
        """Every variable this credential is made of, in manifest order."""
        return list(self.vars or {})

    def stored_var_names(self) -> list[str]:
        """The variables a value is kept for — what a store holds and a process is handed. A ``cli``
        variable is not one (its sign-in lives with the tool), nor an ``oauth`` one (its grant, with the connection)."""
        return [name for name, var in (self.vars or {}).items() if var.holds_value]

    def way_of(self, name: str) -> str:
        """The ONE_OF way ``name`` says — a way's name, or a member variable's (the alias a choice stored before
        ways had names); ``""`` when it names neither."""
        from flow_sdk.schema.data_spec.credential_status_spec import way_named  # noqa: PLC0415

        return way_named(self.vars or {}, name or "")

    def is_way(self, name: str) -> bool:
        """``name`` names a way of this credential's ONE_OF group, or a member of one."""
        return bool(self.way_of(name))

    @property
    def chosen(self) -> str:
        """The way ``setup_choice`` names (a member's name counts as its way); ``""`` otherwise — a choice whose
        way the declaration no longer offers counts as unset."""
        return self.way_of(self.setup_choice)

    def required_var_names(self) -> list[str]:
        """The variables that must have a value for the credential to be connected
        (a deployment may require more: ``Placement.required``)."""
        return [name for name, spec in (self.vars or {}).items() if spec.is_must]

    @property
    def credentials(self) -> SecretRequirements:
        """The names this credential needs a store to hold — the same accessor a data source has."""
        return SecretRequirements(self.stored_var_names())

    async def secret_store(self, deployment: Optional["Deployment"] = None) -> "SecretStore":
        """The store ``deployment`` (default: this computer) keeps this credential's values in,
        configured for this row's scope. Raises ``LookupError`` when its variables are split
        across stores there — ask per variable (``credential_store.secret_store_ref``)."""
        from flow_sdk.builtin.credential_store import Placement, scope_of, secret_store_ref  # noqa: PLC0415
        from flow_sdk.secrets import SecretStore  # noqa: PLC0415

        scope, _ = await scope_of(self)
        if scope is None:
            raise LookupError(f"credential {self.name!r} is a template or its project is gone; it has no store")
        placement = await Placement.of(deployment)
        refs = {ref.key: ref for ref in (secret_store_ref(self, scope, name, placement) for name in self.stored_var_names())}
        if len(refs) != 1:
            raise LookupError(f"credential {self.name!r} keeps its variables in {len(refs)} stores here; ask per variable")
        return SecretStore.from_ref(next(iter(refs.values())))

    # ── sharing: values travel only through the project's vaults ────────────────

    def vault_names(self) -> list[str]:
        """The vaults this credential's variables point into (``secret_ref.vault``), in manifest order, once each."""
        return list(dict.fromkeys(v.secret_ref.vault for v in (self.vars or {}).values() if v.secret_ref is not None))

    async def secret_vault_state(self, project: Optional["Project"] = None) -> dict[str, Any]:
        """What sharing this credential's values needs: ``{holds_values, project_id, vaults, unpublished}`` —
        ``vaults`` the project's declared vault names, ``unpublished`` the stored variables with no ref into one."""
        from flow_sdk.builtin.credential_store import scope_of, vaults_of  # noqa: PLC0415

        if project is None:
            _scope, project = await scope_of(self)
        vaults = sorted(vaults_of(project))
        stored = self.stored_var_names()
        unpublished = [name for name in stored
                       if (ref := self.vars[name].secret_ref) is None or ref.vault not in vaults]
        return {
            "holds_values": bool(stored),
            "project_id": str(project.id) if project is not None else None,
            "vaults": vaults,
            "unpublished": unpublished,
        }

    async def pre_share(self) -> dict[str, Any]:
        """The pre-share handler: a credential's values reach a receiver only through one of the project's
        vaults, so sharing one whose stored variables are not all published to a declared vault asks first."""
        state = await self.secret_vault_state()
        if not state["holds_values"] or not state["unpublished"] or not state["project_id"]:
            return {"needed": False}
        detail = ("Sharing credentials requires a secret manager vault on the project." if not state["vaults"]
                  else "Publish this credential's values to one of the project's vaults before sharing it.")
        return {
            "needed": True, "kind": "secret_vault", "project_id": state["project_id"], "name": self.name,
            "title": f"Share {self.title or self.name}", "detail": detail, "vaults": state["vaults"],
        }

    async def setup_on_receive(self, *, project_id: str | None = None, workdir: str | None = None) -> dict:
        """The receive handler: refresh the project (pull, then re-read its assets) so its manifest — and the
        vaults it names — is current, then open this credential, whose page fetches the values. A project
        with no vault this credential points into opens it with ``receive_error`` (code ``no_vault``), which
        the page shows with Report. A failed refresh is logged and the credential still opens."""
        import logging  # noqa: PLC0415

        from flow_sdk.builtin.credential_service import get_project  # noqa: PLC0415
        from flow_sdk.core.display_target import _entity_payload  # noqa: PLC0415

        project = await get_project(project_id)
        if project is not None:
            try:
                repo = await project.git_workdir()
                if repo is not None and await repo.is_init():
                    pulled = await repo.pull()
                    if pulled.ok and pulled.kind == "pulled":
                        await project.refresh_pulled_assets()
            except Exception as e:  # noqa: BLE001
                logging.getLogger(__name__).warning("[credential] refresh on receive failed: %s", type(e).__name__)
        target = _entity_payload(self)
        if self.stored_var_names():
            state = await self.secret_vault_state(project)
            if not set(self.vault_names()) & set(state["vaults"]):
                target["receive_error"] = {
                    "code": "no_vault",
                    "message": f"{self.title or self.name} was shared without a vault its values can be fetched "
                               "from — ask the sender to set up a secret manager, or report it.",
                }
        return target

    @classmethod
    async def get(cls, name: str, project: Optional["Project"] = None) -> "Credential":
        """The credential named ``name``: ``project``'s (default: the current project's), else the
        user scope's. Raises :class:`CredentialNotFound` or :class:`CredentialAmbiguous`."""
        from flow_sdk import context  # noqa: PLC0415
        from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415

        if project is None:
            project = await context.current_project()
        named = [(spec, scope) for spec, scope in await credentials_in_scope(project) if spec.name == name]
        for wanted in (SCOPE_PROJECT, SCOPE_USER):
            matches = [spec for spec, scope in named if scope.scope == wanted]
            if len(matches) > 1:
                raise CredentialAmbiguous(name, [str(spec.typeid) for spec in matches])
            if matches:
                return matches[0]
        raise CredentialNotFound(name)


async def write_setup_choice(credential: Credential, member: str) -> Credential:
    """Record ``member`` as the way ``credential``'s ONE_OF group is set up here (``""`` clears it) and save — the
    only save that may change it. The ROW only, like ``write_setup_skip``: the file never carries a choice."""
    way = credential.way_of(str(member or ""))
    if member and not way:
        raise ValueError(f"{member!r} is not one of {credential.name!r}'s ways")
    member = way
    if member == (credential.setup_choice or ""):
        return credential
    return await write_projection(credential, CHOICE_FIELD, member)

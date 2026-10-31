"""``flow project setup``: collect what a project needs, and compile it into an ephemeral wizard.

Two pure steps, and the existing runner does the rest:

1. :func:`collect_requirements` reads — never writes — what the project's installed ROOTS need (its data
   sources, agents, dependencies, and the credentials it authored), each requirement carrying its roots, into
   :class:`SetupRequirementSpec` values. Drivers and shipped templates are the catalog: they say how to ask,
   never that something is needed;
2. :func:`compile_setup` turns them into a ``WizardSpec`` plus the ComputeOps it calls, held in
   memory (never a file, never a ``run.json``), for ``run_wizard(resolve_op=…)``.

Each requirement compiles to the shape the shipped ``dev-toolchain`` wizard already uses — the cheap
call, then an agent op for the same goal, sharing ONE completion check so the agent step skips itself
when the cheap one got there:

* oauth — ``flow connections connect <provider>``, checked by ``flow connections test``. No AI rung:
  consent is a person's click.
* pack — one ``ask`` per missing value (masked when secret), then ``flow credentials set --from-inputs``
  checked by ``flow credentials check``; then, when the credential carries ``setup`` instructions,
  the ``provisioner`` agent following them. An empty answer is how a person hands a value to the AI.

Values travel ask → the run's values → the environment of ``flow credentials set``. Nothing prints them.
"""
from __future__ import annotations

import asyncio
import functools
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterable, Optional

from flow_sdk.core.flow_command import flow_command
from flow_sdk.request_context.detached import add_detached_done_callback, create_detached_task
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.credential_contract import CredentialVarKind
from flow_sdk.schema.data_spec.credential_status_spec import CredentialWaySpec, ways
from flow_sdk.schema.data_spec.project_setup_spec import (
    ONE_OF_INPUT,
    REQUIREMENT_DEPENDENCY,
    REQUIREMENT_GAP,
    REQUIREMENT_PACK,
    REQUIREMENT_SOURCE,
    REQUIREMENT_WEBAPP,
    ROOT_AGENT,
    ROOT_CREDENTIAL,
    ROOT_DEPENDENCY,
    ROOT_SOURCE,
    ROOT_WEBAPP,
    ProjectReadinessSpec,
    RootRef,
    SetupRequirementSpec,
    SetupVarSpec,
    input_name,
)
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.project import Project
    from flow_sdk.schema.data_spec.credential_status_spec import CredentialStatusRowSpec

logger = logging.getLogger(__name__)

#: The agent every AI rung runs — "reaches one ComputeOp goal after the cheap attempt failed".
AI_AGENT = "provisioner"
PROJECT = "project"


def _inside(path: str, root: str) -> bool:
    """``path`` is ``root`` or under it — the containment the index uses."""
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under  # noqa: PLC0415

    return bool(path and root) and is_path_under(canonical_posix_path(path), canonical_posix_path(root))


_ROOT_WORDS = {ROOT_SOURCE: "data source", ROOT_AGENT: "agent", ROOT_WEBAPP: "web app",
               ROOT_DEPENDENCY: "dependency", ROOT_CREDENTIAL: "credential"}


def root_label(root: RootRef) -> str:
    return f"the {_ROOT_WORDS.get(root.kind, root.kind)} {root.name!r}"


def _not_ours(root: RootRef, mount: str) -> str:
    """Why Always may not uninstall ``root``; ``""`` when it is an asset in the project's own folder."""
    if not root.asset_ref:
        return f"{root_label(root)} is not declared in this project — skip it locally"
    if not _inside(root.asset_ref, mount):
        return f"{root_label(root)} is not this project's own (it lives outside the project folder) — skip it locally"
    return ""


def skip_always_of(project: "Project", roots: list[RootRef]) -> dict:
    """"Skip → Always" uninstalls a requirement's roots — allowed iff every one is an asset in the project's own
    folder, so the removal is a change to the project (staged in git) and not to someone else's."""
    mount = str(getattr(project, "fs_storage_mount_path", "") or "")
    why = next((reason for root in roots if (reason := _not_ours(root, mount))),
               "" if roots else "nothing installed in this project needs it — skip it locally")
    return {"can_skip_always": not why, "why_not_always": why, "roots": list(roots)}


def _union(items: Iterable[Any], key: Callable[[Any], Any] = lambda item: item) -> list[Any]:
    """``items`` once each, first seen first — scopes, names, roots (by ``key``)."""
    seen: dict[Any, Any] = {}
    for item in items:
        seen.setdefault(key(item), item)
    return list(seen.values())


def _by_typeid(root: RootRef) -> str:
    return root.typeid


# ── 1. collect ────────────────────────────────────────────────────────────────


async def _project_assets(entity: Any, project: "Project") -> list[Any]:
    """The rows of ``entity`` that are the project's: its own (``project_id``), and the assets under its folder
    (an agent's source lands in the agent's project folder). Queried by both keys, never scanned."""
    from flow_sdk.builtin.project import assets_under_roots  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import asset_refs_under  # noqa: PLC0415

    root = str(getattr(project, "fs_storage_mount_path", "") or "")
    keys = [ExpressionNode(op=QueryOp.EQ, operands=["project_id", str(project.id)])]
    if root:
        keys += [ExpressionNode(op=QueryOp.LIKE, operands=["asset_ref", p]) for p in asset_refs_under(root)]
    match = keys[0] if len(keys) == 1 else ExpressionNode(op=QueryOp.OR, operands=keys)
    rows = await entity.get_all(QueryFilter(match=match))
    under = {str(r.id) for r in assets_under_roots(rows, [root])} if root else set()
    return [r for r in rows if str(r.project_id or "") == str(project.id) or str(r.id) in under]


async def project_sources(project: "Project") -> list["DataSource"]:
    """The data sources that are the project's (``_project_assets``)."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    return await _project_assets(DataSource, project)


async def project_agents(project: "Project") -> list[Any]:
    """The agents that are the project's — found by the same rule as its sources."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

    return await _project_assets(Agent, project)


def _root(record: Any, kind: str) -> RootRef:
    name = getattr(record, "name", "") or getattr(record, "provider", "") or record.id
    return RootRef(typeid=str(record.typeid), kind=kind, name=str(name), asset_ref=str(getattr(record, "asset_ref", "") or ""))


@dataclass
class _Connection:
    """A provider the roots act through: the union of the scopes they need, and who needs it."""

    scopes: list[str] = field(default_factory=list)
    roots: list[RootRef] = field(default_factory=list)


@dataclass
class _Needs:
    """What the project's roots need, before any credential row is looked at: credentials by name, connections
    by provider, what nothing declares (gaps) — and the sources walked, for whoever reads on."""

    packs: dict[str, list[RootRef]] = field(default_factory=dict)
    oauth: dict[str, _Connection] = field(default_factory=dict)
    gaps: list[SetupRequirementSpec] = field(default_factory=list)
    sources: list[Any] = field(default_factory=list)

    def needs_credential(self, spec: Any) -> bool:
        """Whether a root still needs the credential row ``spec`` — what keeps a derived row alive."""
        if spec.is_oauth:
            return str(spec.provider or "").lower() in self.oauth
        return str(spec.name) in self.packs


async def _needs_of_roots(project: "Project", known: Any = None) -> _Needs:
    """The one walk from installed roots to needs: each data source (from its driver, ``builtin/readiness.py``),
    then what each of the project's agents authored. A driver or template alone needs nothing. ``known``:
    ``(credentials in scope, shipped templates)`` already read by the caller."""
    from flow_sdk.builtin.readiness import connection_of, requirements_of_source  # noqa: PLC0415
    from flow_sdk.schema.data_spec.requirement_spec import (  # noqa: PLC0415
        REQUIREMENT_CREDENTIAL,
        REQUIREMENT_VARIABLE,
        RequirementSpec,
    )

    needs = _Needs()

    def need(req: "RequirementSpec", root: RootRef) -> Optional[str]:
        """Fold one requirement into the plan; the variable name when nothing declares it."""
        if grant := connection_of(req):
            provider, scopes = grant
            conn = needs.oauth.setdefault(str(provider).lower(), _Connection())
            conn.scopes = _union([*conn.scopes, *scopes])
            conn.roots = _union([*conn.roots, root], _by_typeid)
        elif req.kind == REQUIREMENT_CREDENTIAL:
            needs.packs[req.name] = _union([*needs.packs.get(req.name, []), root], _by_typeid)
        elif req.kind == REQUIREMENT_VARIABLE:
            return req.name
        return None  # an API key is the credential's to provide; IAM is a deployment's grant

    needs.sources = await project_sources(project)
    derived = await asyncio.gather(*(requirements_of_source(s, project, known=known) for s in needs.sources))
    for source, reqs in zip(needs.sources, derived):
        root = _root(source, ROOT_SOURCE)
        unclaimed = [name for req in reqs if (name := need(req, root))]
        if unclaimed:
            needs.gaps.append(SetupRequirementSpec(
                kind=REQUIREMENT_GAP, name=root.name, used_by=[root.name], roots=[root],
                note=f"needs {', '.join(unclaimed)}, and no credential declares it — add one with `setup` instructions",
            ))
    for agent in await project_agents(project):
        root = _root(agent, ROOT_AGENT)
        for req in agent.requirements or []:
            if not req.derived and (name := need(req, root)):
                needs.gaps.append(SetupRequirementSpec(kind=REQUIREMENT_GAP, name=name, used_by=[root.name], roots=[root],
                                                       note=f"{root.name} needs {name}, and no credential declares it"))
    return needs


def _why(credential: "CredentialStatusRowSpec | Credential") -> dict[str, str]:
    """What the credential is needed for, as a requirement carries it — the same from a row and a template."""
    return {"needed_for": credential.needed_for, "justification": credential.justification}


def _setup_var(env_var: str, var: Any, *, login: str, present: bool = False) -> SetupVarSpec:
    """One value as the person is asked for it, from a declaration (``CredentialVarSpec``) or a status row's var."""
    return SetupVarSpec(
        env_var=env_var, label=var.label, hint=var.hint, help_url=var.help_url, placeholder=var.placeholder,
        pattern=var.pattern, secret=var.secret, file=var.kind is CredentialVarKind.FILE, present=present,
        required=var.required, kind=var.kind, login=login, provider=var.provider, scopes=list(var.scopes), way=var.way,
    )


def _names(roots: list[RootRef]) -> list[str]:
    """``used_by`` as it reads: each root's name — ``project`` for a credential the project authored itself."""
    return _union(PROJECT if r.kind == ROOT_CREDENTIAL else r.name for r in roots)


def _from_row(row: "CredentialStatusRowSpec", roots: list[RootRef], project: "Project") -> SetupRequirementSpec:
    always = skip_always_of(project, roots)
    if row.kind == "oauth":
        note = {"needs_reauth": "the grant went stale: connect again",
                "partial": f"connected without {', '.join(row.missing_scopes)}: connect again to grant them"}
        return SetupRequirementSpec(
            kind=REQUIREMENT_PACK, credential_kind="oauth", name=row.name, title=row.title, typeid=row.typeid,
            provider=row.provider, scopes=list(row.scopes), help_url=row.help_url, **_why(row),
            satisfied=row.state == "connected", used_by=_names(roots), note=note.get(row.state, ""),
            skipped=row.setup_skipped, **always,
        )
    # Required when any value is MUST or ONE_OF, and then only those are asked (a ONE_OF group as one choice);
    # a credential of OPTIONAL values alone is listed as optional, with those.
    must = [v for v in row.vars if v.is_must or v.is_one_of]
    return SetupRequirementSpec(
        typeid=row.typeid, kind=REQUIREMENT_PACK, name=row.name, title=row.title, setup=row.setup,
        help_url=row.help_url, setup_timeout_seconds=row.setup_timeout_seconds, **_why(row),
        vars=[_setup_var(v.env_var, v, login=v.login, present=v.present) for v in (must or row.vars)],
        setup_choice=row.setup_choice, ways=dict(row.ways),
        satisfied=row.state == "connected", used_by=_names(roots), required=bool(must),
        note="" if row.setup.strip() else "no setup instructions: AI Assist unavailable",
        skipped=row.setup_skipped, **always,
    )


def _project_skip_key(req: SetupRequirementSpec) -> str:
    """Where a local skip lives when it is kept in the PROJECT's own map: a dependency's under its name, a shipped
    template's under ``credential:<name>`` — the template's record is every project's, so a mark there would skip
    it everywhere."""
    return req.name if req.kind == REQUIREMENT_DEPENDENCY else f"credential:{req.name}"


def _from_template(template: "Credential", roots: list[RootRef], project: "Project",
                   skips: Optional[dict] = None) -> SetupRequirementSpec:
    """A need no row of the project holds yet: the shipped template says how to ask for it; the roots are why."""
    required = {name for name, var in (template.vars or {}).items() if var.is_must or var.is_one_of}
    setup = str(getattr(template, "setup", "") or "")
    req = SetupRequirementSpec(
        typeid=str(template.typeid), required=bool(required),
        kind=REQUIREMENT_PACK, name=str(template.name), title=template.title or str(template.name),
        setup=setup, setup_timeout_seconds=getattr(template, "setup_timeout_seconds", None),
        help_url=template.help_url or "", declared=False, **_why(template), satisfied=False, used_by=_names(roots),
        vars=[
            _setup_var(name, var, login=var.login_command)
            for name, var in (template.vars or {}).items() if name in required
        ],
        ways=dict(getattr(template, "ways", None) or {}),
        note="" if setup.strip() else "no setup instructions: AI Assist unavailable",
        **skip_always_of(project, roots),
    )
    return req.model_copy(update={"skipped": (skips or {}).get(_project_skip_key(req))})


async def _undeclared_connections(project: "Project", wanted: dict[str, _Connection], templates: dict[str, Any],
                                  skips: dict) -> list[SetupRequirementSpec]:
    """The connections the roots act through that no project row holds yet. Nothing is written here: the setup
    step (``requirement_step``) or the source's create declares the row; until then the template (or the
    provider alone) says what to connect, and the grants — read once for all of them — say which are connected."""
    from types import SimpleNamespace  # noqa: PLC0415

    from flow_sdk.builtin.credential_service import _provider_title  # noqa: PLC0415
    from flow_sdk.builtin.credential_status import _grant_key, oauth_states  # noqa: PLC0415

    if not wanted:
        return []
    asked = {}
    for provider, conn in wanted.items():
        template = templates.get(provider)
        template = template if template is not None and template.is_oauth else None
        asked[provider] = (template, _union([*(getattr(template, "scopes", None) or []), *conn.scopes]))
    grants = await oauth_states([SimpleNamespace(is_oauth=True, provider=p, scopes=sc)  # type: ignore[misc]
                                 for p, (_, sc) in asked.items()])
    out = []
    for provider, (template, scopes) in sorted(asked.items()):
        roots = wanted[provider].roots
        req = SetupRequirementSpec(
            kind=REQUIREMENT_PACK, credential_kind="oauth", name=str(template.name) if template else provider,
            provider=provider, scopes=scopes, declared=False,
            title=(template.title if template else "") or await _provider_title(provider),
            typeid=str(template.typeid) if template else str(project.typeid),
            help_url=str(getattr(template, "help_url", "") or ""),
            satisfied=grants.get(_grant_key(provider, scopes), ("missing", []))[0] == "connected",
            used_by=_names(roots), **skip_always_of(project, roots),
        )
        out.append(req.model_copy(update={"skipped": skips.get(_project_skip_key(req))}))
    return out


def is_derived(row: Any) -> bool:
    """A credential a root installed (``derived``), not one the project authored. An oauth row always is: only a
    source or a setup step ever declares one (rows from before the marker carry none)."""
    return bool(getattr(row, "derived", False)) or row.kind == "oauth" or str(row.kind) == "oauth"


async def _collect(project: "Project", deployment_id: str = "") -> tuple[list[SetupRequirementSpec], _Needs]:
    from flow_sdk.builtin import credential_service  # noqa: PLC0415
    from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415
    from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415

    pairs, shipped = await asyncio.gather(credentials_in_scope(project), credential_service.shipped_templates())
    status = await credentials_status(project, deployment_id, pairs=pairs)
    rows: dict[str, "CredentialStatusRowSpec"] = {}
    for row in status.credentials:  # user first, then project: the project's own wins
        rows[row.name] = row
    needs = await _needs_of_roots(project, known=(pairs, shipped))
    packs = needs.packs
    # A credential the project authored is its own root; a derived one is needed through its roots alone.
    for row in status.credentials:
        if row.scope == "project" and not is_derived(row):
            own = RootRef(typeid=row.typeid, kind=ROOT_CREDENTIAL, name=row.name, asset_ref=row.asset_ref)
            packs[row.name] = _union([own, *packs.get(row.name, [])], _by_typeid)

    templates = {str(t.name): t for t in shipped}
    skips = getattr(project, "setup_skipped", None) or {}
    undeclared: dict[str, _Connection] = {}
    narrow: dict[str, list[str]] = {}  # a held row whose scopes do not cover what its roots need yet
    for provider, conn in sorted(needs.oauth.items()):
        held = next((r for r in rows.values() if r.kind == "oauth" and r.scope == "project" and r.provider == provider),
                    None)
        if held is None:
            undeclared[provider] = conn
            continue
        packs[held.name] = _union([*packs.get(held.name, []), *conn.roots], _by_typeid)
        if wider := [sc for sc in conn.scopes if sc not in held.scopes]:
            narrow[held.name] = wider

    out = await _undeclared_connections(project, undeclared, templates, skips)
    for name, roots in packs.items():
        if name in rows:
            req = _from_row(rows[name], roots, project)
            if wider := narrow.get(name):  # the setup step widens the row (``requirement_step``) before connecting
                req = req.model_copy(update={"scopes": [*req.scopes, *wider], "satisfied": False,
                                             "note": f"needs {', '.join(wider)} too: connect again to grant them"})
            out.append(req)
        elif name in templates:
            out.append(_from_template(templates[name], roots, project, skips))
        else:
            out.append(SetupRequirementSpec(
                kind=REQUIREMENT_GAP, name=name, used_by=_names(roots), roots=roots,
                note=f"names the credential {name!r}, which is neither declared nor shipped as a template",
            ))
    # Connections before typed values, as before: a grant is one click, and a source needs it to verify at all.
    out.sort(key=lambda req: not req.is_oauth)
    # Required dependencies not on this machine come first: nothing in them runs until they are.
    # A dependency has no row of its own here (flow.json declares it), so the project carries its skip mark.
    from flow_sdk.builtin import project_dependencies  # noqa: PLC0415

    mount = str(getattr(project, "fs_storage_mount_path", "") or "")
    dependencies = []
    for dep in await project.dependencies():
        if dep.state not in ("missing", "unreachable", "not_found"):
            continue
        key = project_dependencies.requirement_key(dep)
        # Declared in this project's flow.json — unless it came in through another dependency (``via``).
        root = RootRef(typeid=str(project.typeid), kind=ROOT_DEPENDENCY, name=key,
                       asset_ref=str(Path(mount) / "flow.json") if mount and dep.via is None else "")
        dependencies.append(SetupRequirementSpec(
            kind=REQUIREMENT_DEPENDENCY, name=key, title=dep.label or dep.source, typeid=str(project.typeid),
            satisfied=False, used_by=[PROJECT], note=dep.reason or dep.state, required=dep.required,
            skipped=skips.get(key), **skip_always_of(project, [root]),
        ))
    return dependencies + out + needs.gaps, needs


async def collect_requirements(project: "Project", deployment_id: str = "") -> list[SetupRequirementSpec]:
    """Everything ``project`` needs a person (or an agent) to provide, in the order to do it:
    connections first, then credentials, then what cannot be set up here. Read-only: nothing is declared.

    A need comes from a ROOT — an installed data source, agent, dependency, or a credential the project
    authored itself — and is derived again on every read, so it never outlives its root. A credential row a
    root installed (``derived``) is a need only while a root still needs it."""
    return (await _collect(project, deployment_id))[0]


# ── 2. compile ────────────────────────────────────────────────────────────────


def _flow(*args: str, platform: str) -> str:
    """This interpreter's ``flow`` — the checks must reach the same install and instance the CLI runs in."""
    return flow_command(*args, platform=platform)


def _cli(*args: str) -> dict[str, dict[str, str]]:
    return {"commands": {p: _flow(*args, platform=p) for p in ("darwin", "linux", "win32")}}


def _ask_prompt(req: SetupRequirementSpec, var: SetupVarSpec) -> str:
    """The question: the value's label (named for its credential unless it already says it) on the first line, then its hint and its OWN help link.
    The credential's help page is not this value's — glued under an address it sent the person to the
    app-password page. Why the credential is needed rides as the question's detail (``needed_for``)."""
    name, label = req.title or req.name, var.label or var.env_var
    lines = [label if name.lower() in label.lower() else f"{name}: {label}"]
    lines += [text for text in (var.hint, var.help_url) if text]
    return "\n".join(lines)


def _var_choice(var: SetupVarSpec) -> dict[str, Any]:
    return {"value": var.env_var, "label": var.label or var.env_var, "hint": var.hint, "help_url": var.help_url,
            "placeholder": var.placeholder, "secret": var.secret, "file": var.file, "command": var.login, "provider": var.provider,
            "scopes": list(var.scopes)}


def _way_choice(way: str, members: list[SetupVarSpec], offer: Optional[CredentialWaySpec] = None) -> dict[str, Any]:
    """One way of a ONE_OF group as a choice: a single variable is the choice itself; several are one choice
    named by the way (offered as the credential's ``ways`` says), with a field each (answered together)."""
    if len(members) == 1:
        return _var_choice(members[0])
    label = (offer.label if offer else "") or way.replace("_", " ").capitalize()
    hint = offer.hint if offer else ""
    return {"value": way, "label": label, "hint": hint, "secret": any(v.secret for v in members),
            "fields": [_var_choice(v) for v in members]}


def compile_setup(
    project_id: str, requirements: list[SetupRequirementSpec], *, ai: bool = True, deployment_id: str = "",
    connect_here: bool = True, vaults: tuple[str, ...] = (),
) -> tuple[WizardSpec, dict[str, ComputeOpSpec]]:
    """The wizard for ``requirements``, and the ops it calls by name. Every step continues on failure:
    one credential nobody can provide must not stop the next one. ``deployment_id``: store and check
    each value where that deployment keeps it (default: this computer). ``connect_here=False``: a
    connection step only CHECKS — the screen that started the run signs the person in itself (its own
    Connect button, in their browser), so the run never opens a second one on the backend's machine.
    ``vaults``: the project vaults the credential's variables point into — its values are FETCHED from them
    first (``flow secrets fetch``), and a question is asked only for what they could not give (this computer
    only). A fetch a vault refuses ends with code ``denied``: the screen offers Request access."""
    target = ("--deployment", deployment_id) if deployment_id else ()
    where = f"deployment {deployment_id}" if deployment_id else "development"
    ops: dict[str, ComputeOpSpec] = {}
    steps: list[dict[str, Any]] = []

    def add(op: dict[str, Any], **step: Any) -> None:
        spec = ComputeOpSpec.model_validate(op)
        ops[spec.name] = spec
        steps.append({"id": spec.name, "ref": spec.name, "label": spec.label, "on_fail": "continue", **step})

    for req in requirements:
        if req.kind == REQUIREMENT_DEPENDENCY:
            add({
                "name": f"dependency-{req.name}", "label": f"Fetch {req.name}",
                "description": f"{req.name} ({req.title}) is on this machine and in the project's context.",
                "subkind": "cli", "exe_data": _cli("dep", "sync", "--project", project_id),
                "completion_check": _cli("dep", "check", req.name, "--project", project_id),
            })
        elif req.is_oauth:
            provider = req.provider or req.name
            scopes = [arg for s in req.scopes for arg in ("--scope", s)]
            checked_here = {"requirement_step": f"connection:{provider}"}
            add({
                "name": f"connect-{provider}", "label": f"Connect {req.title or provider}",
                "description": f"{provider} is connected and its grant covers what {', '.join(req.used_by)} need.",
                "subkind": "cli",
                # Checked here, in this backend, when a screen signs the person in: no CLI start, and its answer
                # is a sentence ("Needs GitHub sign-in"), not the CLI's log.
                "exe_data": _cli("connections", "connect", provider) if connect_here else checked_here,
                "completion_check": _cli("connections", "test", provider, *scopes) if connect_here else checked_here,
            })
        elif req.kind == REQUIREMENT_PACK:
            # AI Assist on each question: the provisioner follows the credential's own setup.md and
            # answers the question — the person's other way to give the value, not a step of its own.
            assist = AI_AGENT if ai and req.setup.strip() else ""
            check = _cli("credentials", "check", req.name, "--project", project_id, *target)
            # The ONE_OF ways, asked FIRST as one choice; a way of several values is one choice with a field each.
            if vaults and not deployment_id and any(v.kind is not CredentialVarKind.CLI for v in req.missing):
                # The team's copy first: a full fetch satisfies the check, so every question below skips.
                add({
                    "name": f"fetch-{req.name}", "label": f"{req.title or req.name}: fetch from {', '.join(vaults)}",
                    "description": f"{req.name}'s values are fetched from vault {', '.join(vaults)} into {where}.",
                    "subkind": "cli", "exe_data": _cli("secrets", "fetch", req.name, "--project", project_id),
                    "completion_check": check,
                })
            one_of = {v.env_var: v for v in req.missing if v.is_one_of}
            # A sign-in with no command for this OS is not a way here.
            offered = {way: [one_of[m] for m in members] for way, members in ways(one_of).items()
                       if all(v.login or v.kind is not CredentialVarKind.CLI for v in (one_of[m] for m in members))}
            if offered:
                # One question for the whole group: the person picks ONE way. A value way is answered
                # ``<VAR>=<value>`` (newline-joined, one line per field of a several-value way) and stored by
                # the next step; a sign-in way (cli) is done in a terminal, and the question closes by itself
                # once the credential's check holds; an oauth way is the screen's own Sign in (its provider and
                # scopes ride the choice), answered ``<VAR>`` once granted — the store step records the way
                # picked on the credential's row (``setup_choice``).
                add({
                    "name": f"ask-{req.name}-one-of", "label": f"{req.title or req.name}: choose one way",
                    "subkind": "ask", "output_spec_kind": "string",
                    "exe_data": {
                        "prompt": f"How should Flowpad sign in to {req.title or req.name}?", "detail": req.needed_for,
                        "secret": True, "auto_continue": any(v.login for vs in offered.values() for v in vs),
                        "choices": [_way_choice(way, members, req.ways.get(way)) for way, members in offered.items()],
                    },
                    "setup": req.setup, "setup_timeout_seconds": req.setup_timeout_seconds,
                    "completion_check": check,
                }, bind=input_name(req.name, ONE_OF_INPUT))
            for var in req.missing:
                if var.is_one_of:
                    continue
                add({
                    "name": f"ask-{req.name}-{var.env_var}", "label": f"{req.title or req.name}: {var.label or var.env_var}",
                    "subkind": "ask", "output_spec_kind": "string",
                    "exe_data": {"prompt": _ask_prompt(req, var), "detail": req.needed_for, "secret": var.secret,
                                 "file": var.file, "assist_agent": assist},
                    # The credential's own guide rides the question: the person sees how to obtain the
                    # value where they are asked for it.
                    "setup": req.setup, "setup_timeout_seconds": req.setup_timeout_seconds,
                    # The goal's own check: a re-run (resume) asks nobody once the values are stored.
                    "completion_check": check,
                }, bind=input_name(req.name, var.env_var))
            add({
                "name": f"store-{req.name}", "label": f"Store {req.title or req.name}",
                "description": f"{req.name} has every value it needs in {where}.",
                "subkind": "cli", "exe_data": _cli("credentials", "set", req.name, "--project", project_id, *target, "--from-inputs"),
                "completion_check": check,
            })
    wizard = WizardSpec.model_validate({
        "name": "project-setup", "description": "Set up this project's connections and credentials.",
        "icon": "KeyRound", "steps": steps,
    })
    return wizard, ops


# ── 3. readiness, and the setup run the app starts ────────────────────────────

#: The runs this backend started, by project — one at a time per project (the slot says so too).
_RUNS: dict[tuple[str, str], "asyncio.Task"] = {}
#: Each run's live handle (``core/setup/walk.SetupControl``): a skip reaches the node the run is on.
_CONTROLS: dict[tuple[str, str], Any] = {}


def unsatisfied(req: SetupRequirementSpec) -> bool:
    """Not set up yet, whether or not anyone must: what ``to_do`` asks, without the required/skipped filter."""
    if req.is_oauth:
        return req.satisfied is False
    if req.kind == REQUIREMENT_PACK:
        return bool(req.missing)
    if req.kind in (REQUIREMENT_DEPENDENCY, REQUIREMENT_SOURCE, REQUIREMENT_WEBAPP):
        return req.satisfied is False
    return False


def to_do(req: SetupRequirementSpec) -> bool:
    """Still needs someone: a REQUIRED requirement nobody skipped, not set up yet.

    Skipped and optional requirements never count; they are listed beside (``ProjectReadinessSpec``).

    A pack is judged by its MUST values alone — ``satisfied`` (the credential's state) also waits on
    OPTIONAL ones when it has no MUST. A connection only its check can confirm (``None``) is left to
    the wizard's own check; a gap is nobody's to run."""
    return req.required and req.skipped is None and unsatisfied(req)


async def readiness_of(project: "Project", deployment_id: str = "", *,
                       include_ready: bool = False) -> ProjectReadinessSpec:
    """What the footer warning reads: ready, or what is left and what nobody can set up here.

    ``include_ready`` (the Project setup page) also lists what is set up (``set_up``) and names each step's
    tree node (``node``, the ``root`` that runs it alone) — work the footer's poll does not pay for."""
    requirements, needs = await _collect(project, deployment_id)
    if not deployment_id:  # what runs HERE: a source in setup, a web app that does not answer (and, asked, what does)
        requirements += _beyond_credentials(
            await _running_here(project, needs.sources, include_ready=include_ready), requirements)
    if include_ready:
        from flow_sdk.core.setup.derive import requirement_node_id  # noqa: PLC0415 — derive imports this module

        requirements = [r if r.kind == REQUIREMENT_GAP else r.model_copy(update={"node": requirement_node_id(r)})
                        for r in requirements]
    left = [r for r in requirements if to_do(r)]
    return ProjectReadinessSpec(
        project_id=str(project.id), ready=not left, to_do=left,
        optional=[r for r in requirements if not r.required and r.skipped is None and unsatisfied(r)],
        skipped=[r for r in requirements if r.skipped is not None and r.kind != REQUIREMENT_GAP],
        gaps=[r for r in requirements if r.kind == REQUIREMENT_GAP],
        set_up=[r for r in requirements
                if r.skipped is None and r.kind != REQUIREMENT_GAP and r.satisfied and not unsatisfied(r)]
        if include_ready else [],
    )


def _beyond_credentials(running: list[SetupRequirementSpec],
                        listed: list[SetupRequirementSpec]) -> list[SetupRequirementSpec]:
    """One row per need: a source still in setup because a credential (or connection) it uses is not set up is
    that credential's row ("Used by: <source>"), not a second row of its own. A source shows only when it owes
    something beyond what is listed."""
    owed_by = {root.typeid for req in listed if req.kind == REQUIREMENT_PACK and unsatisfied(req) for root in req.roots}
    return [r for r in running if not (r.kind == REQUIREMENT_SOURCE and r.typeid in owed_by)]


async def _running_here(project: "Project", sources: Optional[list] = None, *,
                        include_ready: bool = False) -> list[SetupRequirementSpec]:
    """What values cannot show: each source still in setup, each web app whose server does not answer.
    ``include_ready`` adds the ones that are fine too (``satisfied=True``) — the setup page lists them as Ready.

    Both are read, never probed hard — the row's status, one loopback request per app — so the
    "Setup required" button stays as cheap as the credential check it sits beside."""
    from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    out = [
        SetupRequirementSpec(kind=REQUIREMENT_SOURCE, name=str(source.name or source.provider),
                             satisfied=source.status != SourceStatus.SETUP.value,
                             typeid=str(source.typeid), used_by=[PROJECT],
                             note=str(source.setup_detail or "not set up yet")
                             if source.status == SourceStatus.SETUP.value else "",
                             skipped=source.setup_skipped,
                             **skip_always_of(project, [_root(source, ROOT_SOURCE)]))
        for source in (sources if sources is not None else await project_sources(project))
        if include_ready or source.status == SourceStatus.SETUP.value
    ]
    from flow_sdk.core.webapp import readiness, record  # noqa: PLC0415
    from flow_sdk.schema.data_spec.webapp_lifecycle_spec import LifecycleState  # noqa: PLC0415

    apps = [app for app in await WebApp.get_all({"match": {"project_id": str(project.id)}}) if app.asset_ref]
    # The app's record says whether it is up here (``core/webapp/readiness.quick``: its pids and health, no
    # process table) — the one rule, as cheap as the credential check beside it.
    records = [record.read(str(app.id), str(project.id)) for app in apps]
    answers = list(await asyncio.gather(*(readiness.quick(app, rec) for app, rec in zip(apps, records))))
    # Never brought up here (or not up by its record): one full check, and an app found up — started by hand,
    # or before this backend — is adopted into its record, so the next poll is the cheap one again.
    for i, (app, rec) in enumerate(zip(apps, records)):
        if not answers[i] and rec.state is not LifecycleState.UP or (not answers[i] and not rec.ports):
            verdict = await readiness.ready(app)
            if verdict.ok:
                from flow_sdk.builtin.webapp_setup import _record_up  # noqa: PLC0415

                try:
                    await _record_up(str(app.id), app, str(project.id), verdict)
                except Exception as exc:  # noqa: BLE001 — adopting is a convenience; the verdict stands
                    logger.debug("adopting %s into its record failed: %s", app.name, exc)
                records[i], answers[i] = record.read(str(app.id)), True
            else:
                records[i] = rec.model_copy(update={"detail": verdict.detail or rec.detail})
    out += [
        SetupRequirementSpec(kind=REQUIREMENT_WEBAPP, name=str(app.name), satisfied=bool(ok), used_by=[PROJECT],
                             note=(rec.detail or f"{app.name} is not running") if not ok else "up",
                             typeid=str(app.typeid), skipped=app.setup_skipped,
                             **skip_always_of(project, [_root(app, ROOT_WEBAPP)]))
        for app, rec, ok in zip(apps, records, answers) if include_ready or not ok
    ]
    return out


def setup_run_address(project_id: str, root: str = "") -> str:
    """The run's activity address — what its questions carry (``Question.run``) and a screen claims."""
    from flow_sdk.core.setup import setup_activity_path  # noqa: PLC0415

    return setup_activity_path(root or f"project-{project_id}")


async def start_setup(project: "Project", *, ai: bool = True, root: str = "", tree: Any = None,
                      load_after: bool = True, providers: Any = None, dependency_approval: bool = True,
                      ancestors: tuple[str, ...] = (), connect_here: bool = True) -> str:
    """Start the project's setup in the background and return its address at once.

    The setup is the project's TREE (``core/setup/derive.ProjectTree``): every dependency, connection,
    credential, data source (and its stages), web app and declared ``asset_setup``, each set up after
    what it needs. ``root`` sets up one node of it and what that node needs (a source's own Set up,
    a web app the display found down); empty = the whole project. Its questions reach the app
    (``ask_person`` → the open tab), not a terminal. A run already going for the same root is joined,
    never doubled. ``tree``: a resolver pair (``resolve_node`` / ``resolve_op``) built already — a load
    (``core/setup/load``) hands in the one-node tree it checked, so the project is not derived twice.
    """
    from flow_sdk.core.setup import execute_setup  # noqa: PLC0415
    from flow_sdk.core.setup.derive import ProjectTree  # noqa: PLC0415
    from flow_sdk.core.setup.walk import SetupControl  # noqa: PLC0415

    pid = str(project.id)
    key = (pid, root)
    running = _RUNS.get(key)
    if running is None or running.done():
        tree = tree or await ProjectTree(project, ai=ai, connect_here=connect_here).load()
        control = _CONTROLS[key] = SetupControl()
        mount = str(getattr(project, "fs_storage_mount_path", "") or "")

        async def run_setup():
            # The run's shell: what the setup does not answer itself runs here, one start per run.
            from flow_sdk.builtin.project_dependencies import required_projects  # noqa: PLC0415
            from flow_sdk.core.compute.shared_shell import SharedShell  # noqa: PLC0415
            from flow_sdk.core.setup.load import load_project  # noqa: PLC0415
            from flow_sdk.schema.data_spec.asset_setup_spec import (  # noqa: PLC0415
                LoadState,
                SetupState,
            )

            dependencies = providers if providers is not None else (await required_projects(project) if not root else [])
            # Best effort: a provider that is not ready is said, never a reason to stop setting this one up.
            held: list[str] = []
            for provider in dependencies:
                if str(provider.id) in ancestors:
                    continue
                child = await load_project(provider, approved=dependency_approval, ancestors=(*ancestors, pid))
                if child.state is LoadState.RUNNING:
                    task = _RUNS.get((str(provider.id), ""))
                    outcome = await asyncio.shield(task) if task is not None else None
                    if outcome is not None and outcome.ok:
                        continue
                elif child.state is LoadState.READY:
                    continue
                held.append(f"Dependency {provider.name}: {child.detail}")

            async with SharedShell() as base:
                result = await execute_setup(
                    root or tree.root, resolve_node=tree.resolve_node, resolve_op=tree.resolve_op,
                    subject_entity=f"project-{pid}", cwd=Path(mount) if mount else None,
                    shell=functools.partial(_setup_shell, inner=base),
                    # A person pressed Set up on THIS project: every node in it is theirs to run.
                    approved=True, control=control,
                )
                if load_after:
                    # Best effort: what IS set up loads (an app starts) even when something beside it is not.
                    # The setup's own verdict stays the answer when it fell short.
                    from flow_sdk.core.setup.load import LoadTree  # noqa: PLC0415

                    operational = LoadTree(tree)
                    loaded = await execute_setup(
                        root or tree.root, resolve_node=operational.resolve_node, resolve_op=operational.resolve_op,
                        subject_entity=f"project-{pid}", cwd=Path(mount) if mount else None,
                        shell=functools.partial(_setup_shell, inner=base), approved=True, control=control,
                        # Its "done" (a source has nothing to load) must never stand in for a setup that fell
                        # short: the run's record stays the setup's own verdict.
                        record=result.ok,
                    )
                    result = loaded if result.ok else result
                if held and result.ok:
                    return result.model_copy(update={"state": SetupState.BLOCKED, "detail": "; ".join(held)})
                return result

        # Detached: the run takes minutes and asks the person questions; a plain task
        # (and a plain done-callback) would hold the Set-up request for all of it.
        task = create_detached_task(run_setup(), name=f"project-setup:{pid}:{root}")
        add_detached_done_callback(task, _log_failure)
        add_detached_done_callback(task, functools.partial(_release_control, key, control))
        add_detached_done_callback(task, functools.partial(_forget_load, pid, root))
        _RUNS[key] = task
    return setup_run_address(pid, root)


async def requirement_step(project_id: str, which: str, *, check: bool) -> tuple[bool, str]:
    """What a setup requirement itself needs, for ``project_id`` — the nodes below a connection in the tree.

    * ``credential:<provider>:<project id>:<scope>,...``: the project holds an oauth credential for the provider. Run (not a
      check), a missing one is installed from the catalog's template (``declare_oauth``) — the same declaration a
      source makes when it is created.
    * ``provider:<provider>``: a sign-in for the provider exists — shipped with this build, or on the hub.
    """
    from flow_sdk.builtin import credential_service  # noqa: PLC0415
    from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415

    # Scopes go last: one may hold a colon itself (GitHub's ``read:org``).
    kind, provider, named, scopes = (which.split(":", 3) + ["", "", ""])[:4]
    provider = provider.strip().lower()
    project_id = named or project_id  # the step names its project: a run rooted at one source carries none
    if kind == "provider":
        from flow_sdk.core.oauth.provider_registry import get_local_provider  # noqa: PLC0415

        if get_local_provider(provider) is not None:
            return True, "Ships with Flowpad"
        try:
            from flow_sdk.core.connections.specs import resolve_connection_spec  # noqa: PLC0415

            if await resolve_connection_spec(provider) is not None:
                return True, "Available on the hub"
        except Exception as exc:  # noqa: BLE001 — not knowing is said, never raised
            return False, f"Could not ask the hub about {provider}: {exc}"
        return False, f"No {provider} sign-in on this machine or on the hub"
    if kind == "connection":
        from flow_sdk.builtin.data_source import connection_need  # noqa: PLC0415

        need = await connection_need(provider)
        return (True, "Connected") if need is None else (False, need.detail)
    if kind != "credential":
        return False, f"unknown requirement step {which!r}"
    try:
        project = await credential_service.get_project(project_id)
    except ValueError:  # not an id at all — said as a verdict, like any other answer of a step
        project = None
    if project is None:
        return False, f"no project {project_id}"
    wanted = [s for s in scopes.split(",") if s]
    pairs = await credentials_in_scope(project)
    held = next((spec for spec, _ in pairs if spec.is_oauth and str(spec.provider or "").lower() == provider), None)
    if held is not None and set(wanted) <= set(held.scopes or []):
        return True, "In this project"
    if check:
        return False, "Not in this project yet" if held is None else "In this project, without every scope it needs"
    await credential_service.declare_oauth(project, provider, wanted)
    return True, "Added from the catalog" if held is None else "Widened to what the project needs"


def _own_check(command: str) -> Optional[tuple[str, str, str]]:
    """``(name, project_id, deployment_id)`` when ``command`` is this interpreter's
    ``flow credentials check`` — the check a setup step runs before it asks — else None."""
    import re  # noqa: PLC0415
    import shlex  # noqa: PLC0415
    import sys  # noqa: PLC0415

    if command.startswith("& '"):  # Windows: flow_command's PowerShell spelling — the exe and each argument quoted
        exe, *args = [token.replace("''", "'") for token in re.findall(r"'((?:[^']|'')*)'", command)] or [""]
        argv = [exe, "-m", "flow_sdk.cli.flow_cli", *args] if " -m flow_sdk.cli.flow_cli " in command else []
    else:
        try:
            argv = shlex.split(command)
        except ValueError:
            return None
    if argv[:5] != [sys.executable, "-m", "flow_sdk.cli.flow_cli", "credentials", "check"] or len(argv) < 6:
        return None
    options = argv[6:]
    given = dict(zip(options[::2], options[1::2]))
    return argv[5], given.get("--project", ""), given.get("--deployment", "")


def setup_shell_answers(command: str) -> bool:
    """``command`` is a check the setup's shell answers in this process — its detail is a reason."""
    return _own_check(command) is not None


async def _setup_shell(command: str, *, timeout_seconds: float, workdir: Path, extra_env: Optional[dict] = None,
                       platform: str = "", stop: Optional[asyncio.Event] = None, on_output=None,
                       on_spawn=None, fresh: bool = False, inner=None):
    """The setup's shell: its own credential checks answered here, everything else run as usual.

    Every step checks its goal before it asks, and ``flow credentials check`` as a process imports
    the CLI and, with no backend to reach, opens the database — about a second before each question,
    measured, and 27 s on a loaded Windows machine (past the check's limit, so a connected credential
    read as missing). The setup runs inside the instance the check would ask, so it asks the same
    ``credentials_status`` directly: same row (the project's own before the user's), same verdict
    (``connected`` is ready), same exit codes, on every OS. Everything else goes to *inner*, the
    run's shell."""
    import json  # noqa: PLC0415
    import time  # noqa: PLC0415

    from flow_sdk.core.compute.exec import run_shell  # noqa: PLC0415

    own = _own_check(command)
    if own is None:
        return await (inner or run_shell)(command, timeout_seconds=timeout_seconds, workdir=workdir,
                                          extra_env=extra_env, platform=platform, stop=stop,
                                          on_output=on_output, on_spawn=on_spawn, fresh=fresh)
    from flow_sdk.builtin.credential_status import credentials_status, why_not_ready  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode  # noqa: PLC0415

    started = time.monotonic()
    name, project_id, deployment_id = own
    project = await Project.get_one({"id": project_id}) if project_id else None
    status = (await credentials_status(project, deployment_id)).model_dump(mode="json")
    rows = [row for row in status.get("credentials") or [] if row.get("name") == name]
    row = next((r for r in rows if r.get("scope") == "project"), rows[0] if rows else None)
    ready = row is not None and row.get("state") == "connected"
    said = json.dumps({"name": name, "declared": row is not None, "ready": ready})
    # Why it is not ready rides as the answer's detail: a step's check says it in its own words.
    return CliResult.of_process(command, 0 if ready else int(ExitCode.NOT_YET), said,
                                duration_s=time.monotonic() - started, detail=why_not_ready(row))


def _release_control(key: tuple[str, str], control: Any, _task: "asyncio.Task") -> None:
    """A finished run's handle goes — unless a newer run of the same root already took its place."""
    if _CONTROLS.get(key) is control:
        del _CONTROLS[key]


def _forget_load(project_id: str, root: str, _task: "asyncio.Task") -> None:
    """A run of the project ended: the load verdicts it outdates go (``load.forget`` decides which)."""
    from flow_sdk.core.setup.load import forget  # noqa: PLC0415

    forget(project_id, root)


def _log_failure(task: "asyncio.Task") -> None:
    """A run that raised is recorded nowhere else — say it, rather than let it vanish."""
    if not task.cancelled() and task.exception() is not None:
        logger.error("project setup run failed", exc_info=task.exception())


async def stop_setup(project_id: str, root: str = "") -> bool:
    """Stop the run going for ``root`` (``SetupControl.stop``): the step it is on is cancelled the way a
    replaced wizard start is — its shells' process groups killed, its open question withdrawn — and the run
    is awaited until it has let go of its slot. Its record says STOPPED; starting again resumes, every step
    already done answering "already set up". ``False`` when nothing was running."""
    key = (project_id, root)
    task = _RUNS.get(key)
    if task is None or task.done():
        return False
    control = _CONTROLS.get(key)
    if control is None or not control.stop():
        task.cancel("stopped by a person")  # not in a step yet (still loading what it depends on)
    await asyncio.wait({task})
    return True


def setup_run(project_id: str, root: str = "") -> dict[str, Any]:
    """The run's live state: whether it is going, and its tree so far (recorded after every step)."""
    from flow_sdk.core.setup import read_setup  # noqa: PLC0415

    task = _RUNS.get((project_id, root))
    tree = read_setup(root or f"project-{project_id}")
    return {
        "run": setup_run_address(project_id, root),
        "running": task is not None and not task.done(),
        "tree": tree.model_dump(mode="json") if tree is not None else None,
    }


# ── 4. skipping ───────────────────────────────────────────────────────────────

SKIP_LOCAL = "local"
SKIP_ALWAYS = "always"


class SkipRefused(ValueError):
    """A skip that cannot be done — the message says why, in the person's words."""


async def requirement_of(project: "Project", typeid: str, name: str = "") -> SetupRequirementSpec:
    """The requirement ``typeid`` (a dependency: the project's typeid and its ``name``) as the project's setup
    lists it — what a skip may act on, and nothing else."""
    def match(reqs: list[SetupRequirementSpec]) -> Optional[SetupRequirementSpec]:
        # The typeid names it — save the ones that share one: a dependency (the project's) and a connection no
        # template ships (the project's too), told apart by name.
        return next((r for r in reqs if r.typeid == typeid and (not name or r.name == name)), None)

    # The running ones (a live probe per web app) only when the declared ones do not name it.
    if (req := match(await collect_requirements(project)) or match(await _running_here(project))) is not None:
        return req
    raise SkipRefused(f"{name or typeid} is not something this project's setup lists")


def _marks_project(req: SetupRequirementSpec) -> bool:
    """A local skip kept in the project's own map: a dependency (flow.json is its record) and a need no row of the
    project holds yet (its template is every project's)."""
    return req.kind == REQUIREMENT_DEPENDENCY or (req.kind == REQUIREMENT_PACK and not req.declared)


async def _record_of(req: SetupRequirementSpec):
    from flow_sdk.core import Entity  # noqa: PLC0415

    if req.kind not in (REQUIREMENT_PACK, REQUIREMENT_SOURCE, REQUIREMENT_WEBAPP):
        raise SkipRefused(f"a {req.kind} cannot be skipped")
    record = await Entity.get_by_typeid(req.typeid)
    if record is None:  # every listed requirement IS an indexed row: a missing one is the index's to fix
        raise SkipRefused(f"{req.name} has no record here — index the project and try again")
    return record


async def skip_requirement(project: "Project", typeid: str, *, scope: str = SKIP_LOCAL, name: str = "",
                           note: str = "", by: str = "") -> None:
    """Skip a requirement of ``project``'s setup.

    * ``local`` — a mark on its own record, on this machine (``core/setup/skip_mark``): it stops counting and its
      tree node settles SKIPPED. Undone by :func:`unskip_requirement`.
    * ``always`` — the requirement stops existing: its ROOTS are uninstalled (a source, an agent, a credential the
      project authored; a dependency leaves flow.json), with every credential they installed, and the removal is
      STAGED in git for the person to commit. Only when every root is the project's own (``can_skip_always``)."""
    import time  # noqa: PLC0415

    from flow_sdk.core.setup.derive import skip_detail  # noqa: PLC0415
    from flow_sdk.core.setup.skip_mark import write_setup_skip  # noqa: PLC0415
    from flow_sdk.schema.data_spec.asset_setup_spec import SetupSkipSpec  # noqa: PLC0415

    req = await requirement_of(project, typeid, name)
    if scope == SKIP_ALWAYS:
        if not req.can_skip_always:
            raise SkipRefused(req.why_not_always or f"{req.name} cannot be removed from this project")
        await _uninstall(project, req.roots)
        _skip_live(project, req, "removed from the project")
        return
    if scope != SKIP_LOCAL:
        raise SkipRefused(f"skip {scope!r}? it is {SKIP_LOCAL!r} or {SKIP_ALWAYS!r}")
    mark = SetupSkipSpec(at=time.time(), by=by, note=note.strip())
    if _marks_project(req):
        await write_setup_skip(project, {**(project.setup_skipped or {}), _project_skip_key(req): mark})
    else:
        await write_setup_skip(await _record_of(req), mark)
    _skip_live(project, req, skip_detail(mark))


async def skip_asking(run: str, step: str, *, by: str = "") -> bool:
    """A setup question's own Skip: skip, on this machine, the ``step`` of setup run ``run`` that asked — the same
    local skip its row offers (undone from the setup list), so the run goes on without it. ``False`` when no
    setup run of that address is going."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.core.setup.derive import requirement_node_id  # noqa: PLC0415

    pid = next((pid for pid, root in _CONTROLS if setup_run_address(pid, root) == run), None)
    if pid is None:
        return False
    project = await Project.get_one({"id": pid})
    req = next((r for r in await collect_requirements(project) if requirement_node_id(r) == step), None)
    if req is None:
        raise SkipRefused("the step asking is not one this project's setup lists")
    await skip_requirement(project, req.typeid, name=req.name, by=by)
    return True


def _skip_live(project: "Project", req: SetupRequirementSpec, detail: str) -> None:
    """A run going for this project reads the skip now: its node settles SKIPPED, even the one it is on."""
    from flow_sdk.core.setup.derive import requirement_node_id  # noqa: PLC0415

    node_id, project_id = requirement_node_id(req), str(project.id)
    for (pid, _root), control in _CONTROLS.items():  # the runs going: a finished one is dropped
        if pid == project_id:
            control.skip(node_id, detail)


async def unskip_requirement(project: "Project", typeid: str, *, name: str = "") -> None:
    """Undo a local skip: the requirement is listed and counted again."""
    from flow_sdk.core.setup.skip_mark import write_setup_skip  # noqa: PLC0415

    req = await requirement_of(project, typeid, name)
    if _marks_project(req):
        key = _project_skip_key(req)
        await write_setup_skip(project, {k: v for k, v in (project.setup_skipped or {}).items() if k != key})
    else:
        await write_setup_skip(await _record_of(req), None)


async def _delete_credential_staged(mount: Path, record: Any) -> None:
    """A credential goes with its values and this machine's store pins, the way it is always deleted; staged."""
    from flow_sdk.builtin.credential_service import delete_credential  # noqa: PLC0415

    if not (await delete_credential(str(record.typeid))).removed:
        raise SkipRefused(f"{record.name}'s values could not all be removed — delete it from Credentials")
    await _stage(mount, Path(str(record.asset_ref or "")))


async def _delete_source(mount: Path, record: Any) -> None:
    await type(record).delete_by_id(str(record.id))  # its own path: children, row, folder
    await _stage(mount, Path(str(record.asset_ref or "")))


async def _delete_folder_asset(mount: Path, record: Any) -> None:
    from flow_sdk.assets.asset import Asset  # noqa: PLC0415

    folder = Path(str(record.asset_ref or ""))
    if folder.exists():
        Asset.from_path(str(folder)).remove()
    await record.delete()
    await _stage(mount, folder)


#: How each kind of root is uninstalled — through its own delete, then staged.
_UNINSTALL = {ROOT_CREDENTIAL: _delete_credential_staged, ROOT_SOURCE: _delete_source,
              ROOT_AGENT: _delete_folder_asset, ROOT_WEBAPP: _delete_folder_asset}


async def _uninstall(project: "Project", roots: list[RootRef]) -> None:
    """"Skip → Always": each root leaves the project folder and the index through its own delete, then every
    derived credential no remaining root needs; git stages each removal."""
    from flow_sdk.core import Entity  # noqa: PLC0415

    mount = Path(str(project.fs_storage_mount_path or ""))
    for root in roots:
        if root.kind == ROOT_DEPENDENCY:
            await project.remove_dependency(root.name)
            await _stage(mount, mount / "flow.json")
        elif (record := await Entity.get_by_typeid(root.typeid)) is not None:
            await _UNINSTALL[root.kind](mount, record)
    await _drop_orphans(project)


async def _drop_orphans(project: "Project") -> None:
    """The project's derived credentials no installed root needs any more — deleted, values and all, staged."""
    from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415

    mount = Path(str(project.fs_storage_mount_path or ""))
    pairs = await credentials_in_scope(project)
    needs = await _needs_of_roots(project, known=(pairs, None))
    for spec, _ in pairs:
        if spec.scope == "project" and is_derived(spec) and not needs.needs_credential(spec):
            await _delete_credential_staged(mount, spec)


async def _stage(root: Path, path: Path) -> None:
    """Stage ``path``'s removal (or change) in the git repository holding it — never a commit; nothing when
    the project is not in git."""
    from flow_sdk.utils.git import _git, find_project_root  # noqa: PLC0415

    top = find_project_root(str(root))
    if top is None:
        return  # not a git checkout: the removal on disk is the whole change
    result = await _git(["git", "add", "-A", "--", str(path)], top)
    if result.returncode != 0:
        logger.warning("setup: could not stage %s: %s", path, (result.stderr or result.stdout or "").strip())

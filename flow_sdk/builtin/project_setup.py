"""``flow project setup``: collect what a project needs, and compile it into an ephemeral wizard.

Two pure steps, and the existing runner does the rest:

1. :func:`collect_requirements` reads — never writes — the credentials the project declares and the
   auth its data sources' drivers name, into :class:`SetupRequirementSpec` values;
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
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.core.flow_command import flow_command
from flow_sdk.request_context.detached import add_detached_done_callback, create_detached_task
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.credential_contract import CredentialVarKind
from flow_sdk.schema.data_spec.project_setup_spec import (
    REQUIREMENT_DEPENDENCY,
    REQUIREMENT_GAP,
    REQUIREMENT_PACK,
    REQUIREMENT_SOURCE,
    REQUIREMENT_WEBAPP,
    ProjectReadinessSpec,
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


def _always(why_not: str = "") -> dict:
    """A requirement's "Skip → Always" fields: allowed unless there is a reason not to."""
    return {"can_skip_always": not why_not, "why_not_always": why_not}


def always_for(project: "Project", asset_ref: str, *, what: str) -> dict:
    """Whether "Skip → Always" can remove an asset from ``project`` — only an asset in the project's own folder,
    so the removal is a change to the project (staged in git) and not to someone else's."""
    root = str(getattr(project, "fs_storage_mount_path", "") or "")
    if not asset_ref:
        return _always(f"{what} has no folder in this project")
    if not _inside(asset_ref, root):
        return _always(f"{what} is not this project's own (it lives outside the project folder) — skip it locally")
    return _always()


# ── 1. collect ────────────────────────────────────────────────────────────────


async def project_sources(project: "Project") -> list["DataSource"]:
    """The data sources that are the project's: its own rows, and the source assets under its folder
    (an agent's source lands in the agent's project folder). Queried by both keys, never scanned."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.project import assets_under_roots  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    root = str(getattr(project, "fs_storage_mount_path", "") or "")
    keys = [ExpressionNode(op=QueryOp.EQ, operands=["project_id", str(project.id)])]
    for prefix in dict.fromkeys(p.rstrip("/") for p in ((root, canonical_posix_path(root)) if root else ())):
        keys.append(ExpressionNode(op=QueryOp.LIKE, operands=["asset_ref", f"{prefix}/%"]))
    match = keys[0] if len(keys) == 1 else ExpressionNode(op=QueryOp.OR, operands=keys)
    rows = await DataSource.get_all(QueryFilter(match=match))
    under = {str(r.id) for r in assets_under_roots(rows, [root])} if root else set()
    return [r for r in rows if str(r.project_id or "") == str(project.id) or str(r.id) in under]


def _pack_always(project: "Project", row: "CredentialStatusRowSpec", used_by: list[str]) -> dict:
    """"Skip → Always" removes a credential's declaration from the project — never a user one (every project
    reads it) and never an oauth one a source still acts through (the need would come straight back)."""
    if row.scope != "project":
        return _always("declared for all your projects (user scope): change it from Credentials")
    sources = [who for who in used_by if who != PROJECT]
    if row.kind == "oauth" and sources:
        return _always(f"needed by {', '.join(sources)} — remove {'it' if len(sources) == 1 else 'them'} first")
    return always_for(project, row.asset_ref, what=f"the credential {row.name!r}")


def _why(credential: "CredentialStatusRowSpec | Credential") -> dict[str, str]:
    """What the credential is needed for, as a requirement carries it — the same from a row and a template."""
    return {"needed_for": credential.needed_for, "justification": credential.justification}


def _from_row(row: "CredentialStatusRowSpec", used_by: list[str], project: "Project") -> SetupRequirementSpec:
    always = _pack_always(project, row, used_by)
    if row.kind == "oauth":
        note = {"needs_reauth": "the grant went stale: connect again",
                "partial": f"connected without {', '.join(row.missing_scopes)}: connect again to grant them"}
        return SetupRequirementSpec(
            kind=REQUIREMENT_PACK, credential_kind="oauth", name=row.name, title=row.title, typeid=row.typeid,
            provider=row.provider, scopes=list(row.scopes), help_url=row.help_url, **_why(row),
            satisfied=row.state == "connected", used_by=used_by, note=note.get(row.state, ""),
            skipped=row.setup_skipped, **always,
        )
    # Required when any value is MUST, and then only the MUST values are asked; a credential of OPTIONAL values
    # alone is listed as optional, with those.
    must = [v for v in row.vars if v.is_must]
    return SetupRequirementSpec(
        typeid=row.typeid, kind=REQUIREMENT_PACK, name=row.name, title=row.title, setup=row.setup,
        help_url=row.help_url, setup_timeout_seconds=row.setup_timeout_seconds, **_why(row),
        vars=[
            SetupVarSpec(env_var=v.env_var, label=v.label, hint=v.hint, help_url=v.help_url,
                         pattern=v.pattern, secret=v.secret, file=v.kind is CredentialVarKind.FILE,
                         present=v.present)
            for v in (must or row.vars)
        ],
        satisfied=row.state == "connected", used_by=used_by, required=bool(must),
        note="" if row.setup.strip() else "no setup instructions: AI Assist unavailable",
        skipped=row.setup_skipped, **always,
    )


def _from_template(template: "Credential", used_by: list[str]) -> SetupRequirementSpec:
    required = set(template.required_var_names())
    setup = str(getattr(template, "setup", "") or "")
    return SetupRequirementSpec(
        typeid=str(template.typeid), required=bool(required),
        why_not_always="a shipped template, not in this project yet: skip it locally",
        kind=REQUIREMENT_PACK, name=str(template.name), title=template.title or str(template.name),
        setup=setup, setup_timeout_seconds=getattr(template, "setup_timeout_seconds", None),
        help_url=template.help_url or "", declared=False, **_why(template), satisfied=False, used_by=used_by,
        vars=[
            SetupVarSpec(env_var=name, label=var.label, hint=var.hint, help_url=var.help_url,
                         pattern=var.pattern, secret=var.secret, file=var.kind is CredentialVarKind.FILE)
            for name, var in (template.vars or {}).items() if name in required
        ],
        note="" if setup.strip() else "no setup instructions: AI Assist unavailable",
    )


async def collect_requirements(project: "Project", deployment_id: str = "") -> list[SetupRequirementSpec]:
    """Everything ``project`` needs a person (or an agent) to provide, in the order to do it:
    connections first, then credentials, then what cannot be set up here. Read-only."""
    from flow_sdk.builtin import credential_service  # noqa: PLC0415
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415
    from flow_sdk.builtin.readiness import (
        connection_of,  # noqa: PLC0415
        requirements_of_source,  # noqa: PLC0415
    )
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.requirement_spec import (  # noqa: PLC0415
        REQUIREMENT_CREDENTIAL,
        REQUIREMENT_VARIABLE,
        RequirementSpec,
    )

    status = await credentials_status(project, deployment_id)
    rows: dict[str, "CredentialStatusRowSpec"] = {}
    for row in status.credentials:  # user first, then project: the project's own wins
        rows[row.name] = row
    templates = await credential_service.shipped_templates()

    oauth: dict[str, dict[str, list[str]]] = {}
    packs: dict[str, list[str]] = {row.name: [PROJECT] for row in status.credentials if row.scope == "project"}
    gaps: list[SetupRequirementSpec] = []

    def need(req: "RequirementSpec", who: str) -> Optional[str]:
        """Fold one requirement into the plan; the variable name when nothing declares it."""
        if grant := connection_of(req):
            provider, scopes = grant
            entry = oauth.setdefault(provider, {"scopes": [], "used_by": []})
            entry["scopes"] += [s for s in scopes if s not in entry["scopes"]]
            if who not in entry["used_by"]:
                entry["used_by"].append(who)
        elif req.kind == REQUIREMENT_CREDENTIAL:
            if who not in packs.setdefault(req.name, []):
                packs[req.name].append(who)
        elif req.kind == REQUIREMENT_VARIABLE:
            return req.name
        return None  # an API key is the credential's to provide; IAM is a deployment's grant

    # The same derivation an agent's requirements come from (``builtin/readiness.py``), per source;
    # then what each of the project's agents authored.
    for source in await project_sources(project):
        who = str(source.name or source.provider)
        unclaimed = [name for req in await requirements_of_source(source, project) if (name := need(req, who))]
        if unclaimed:
            gaps.append(SetupRequirementSpec(
                kind=REQUIREMENT_GAP, name=who, used_by=[who],
                note=f"needs {', '.join(unclaimed)}, and no credential declares it — add one with `setup` instructions",
            ))
    for agent in await Agent.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.EQ, operands=["project_id", str(project.id)]))):
        who = str(agent.name or agent.id)
        for req in agent.requirements or []:
            if not req.derived and (name := need(req, who)):
                gaps.append(SetupRequirementSpec(kind=REQUIREMENT_GAP, name=name, used_by=[who],
                                                 note=f"{who} needs {name}, and no credential declares it"))

    # A connection a source acts through IS a credential (``kind: oauth``): the project declares it — with the
    # union of the scopes its requesters need — so it is an indexed asset with a row, like any other.
    # Declared once (a source's create declares it too): only a provider no project row covers yet is written.
    changed = False
    for provider, entry in sorted(oauth.items()):
        held = next((r for r in rows.values() if r.kind == "oauth" and r.scope == "project"
                     and r.provider == provider.lower() and set(entry["scopes"]) <= set(r.scopes)), None)
        if held is not None:
            name = held.name
        else:
            spec, declared = await credential_service.declare_oauth(project, provider, entry["scopes"])
            name, changed = str(spec.name), changed or declared
        for who in entry["used_by"]:
            if who not in packs.setdefault(name, []):
                packs[name].append(who)
    if changed:  # read again: the declarations are rows now
        status = await credentials_status(project, deployment_id)
        for row in status.credentials:
            rows[row.name] = row

    out: list[SetupRequirementSpec] = []
    by_template = {str(t.name): t for t in templates}
    for name, used_by in packs.items():
        if name in rows:
            out.append(_from_row(rows[name], used_by, project))
        elif name in by_template:
            out.append(_from_template(by_template[name], used_by))
        else:
            out.append(SetupRequirementSpec(
                kind=REQUIREMENT_GAP, name=name, used_by=used_by,
                note=f"names the credential {name!r}, which is neither declared nor shipped as a template",
            ))
    # Connections before typed values, as before: a grant is one click, and a source needs it to verify at all.
    out.sort(key=lambda req: not req.is_oauth)
    # Required dependencies not on this machine come first: nothing in them runs until they are.
    # A dependency has no row of its own here (flow.json declares it), so the project carries its skip mark.
    from flow_sdk.builtin import project_dependencies  # noqa: PLC0415

    skips = getattr(project, "setup_skipped", None) or {}
    dependencies = []
    for dep in await project.dependencies():
        if dep.state not in ("missing", "unreachable", "not_found"):
            continue
        key = project_dependencies.requirement_key(dep)
        dependencies.append(SetupRequirementSpec(
            kind=REQUIREMENT_DEPENDENCY, name=key, title=dep.label or dep.source, typeid=str(project.typeid),
            satisfied=False, used_by=[PROJECT], note=dep.reason or dep.state, required=dep.required,
            skipped=skips.get(key), can_skip_always=dep.via is None,
        ))
    return dependencies + out + gaps


# ── 2. compile ────────────────────────────────────────────────────────────────


def _flow(*args: str, platform: str) -> str:
    """This interpreter's ``flow`` — the checks must reach the same install and instance the CLI runs in."""
    return flow_command(*args, platform=platform)


def _cli(*args: str) -> dict[str, dict[str, str]]:
    return {"commands": {p: _flow(*args, platform=p) for p in ("darwin", "linux", "win32")}}


def _ask_prompt(req: SetupRequirementSpec, var: SetupVarSpec) -> str:
    lines = [f"{req.title or req.name}: {var.label or var.env_var}"]
    lines += [text for text in (var.hint, var.help_url or req.help_url) if text]
    return "\n".join(lines)


def compile_setup(
    project_id: str, requirements: list[SetupRequirementSpec], *, ai: bool = True, deployment_id: str = ""
) -> tuple[WizardSpec, dict[str, ComputeOpSpec]]:
    """The wizard for ``requirements``, and the ops it calls by name. Every step continues on failure:
    one credential nobody can provide must not stop the next one. ``deployment_id``: store and check
    each value where that deployment keeps it (default: this computer)."""
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
            add({
                "name": f"connect-{provider}", "label": f"Connect {req.title or provider}",
                "description": f"{provider} is connected and its grant covers what {', '.join(req.used_by)} need.",
                "subkind": "cli", "exe_data": _cli("connections", "connect", provider),
                "completion_check": _cli("connections", "test", provider, *scopes),
            })
        elif req.kind == REQUIREMENT_PACK:
            # AI Assist on each question: the provisioner follows the credential's own setup.md and
            # answers the question — the person's other way to give the value, not a step of its own.
            assist = AI_AGENT if ai and req.setup.strip() else ""
            check = _cli("credentials", "check", req.name, "--project", project_id, *target)
            for var in req.missing:
                add({
                    "name": f"ask-{req.name}-{var.env_var}", "label": f"{req.title or req.name}: {var.label or var.env_var}",
                    "subkind": "ask", "output_spec_kind": "string",
                    "exe_data": {"prompt": _ask_prompt(req, var), "secret": var.secret, "file": var.file,
                                 "assist_agent": assist},
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


async def readiness_of(project: "Project", deployment_id: str = "") -> ProjectReadinessSpec:
    """What the footer warning reads: ready, or what is left and what nobody can set up here."""
    requirements = await collect_requirements(project, deployment_id)
    if not deployment_id:  # what runs HERE: a source in setup, a web app that does not answer
        requirements += await _running_here(project)
    left = [r for r in requirements if to_do(r)]
    return ProjectReadinessSpec(
        project_id=str(project.id), ready=not left, to_do=left,
        optional=[r for r in requirements if not r.required and r.skipped is None and unsatisfied(r)],
        skipped=[r for r in requirements if r.skipped is not None and r.kind != REQUIREMENT_GAP],
        gaps=[r for r in requirements if r.kind == REQUIREMENT_GAP],
    )


async def _running_here(project: "Project") -> list[SetupRequirementSpec]:
    """What values cannot show: each source still in setup, each web app whose server does not answer.

    Both are read, never probed hard — the row's status, one loopback request per app — so the
    "Setup required" button stays as cheap as the credential check it sits beside."""
    from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.builtin.webapp_setup import step  # noqa: PLC0415

    out = [
        SetupRequirementSpec(kind=REQUIREMENT_SOURCE, name=str(source.name or source.provider), satisfied=False,
                             typeid=str(source.typeid), used_by=[PROJECT],
                             note=str(source.setup_detail or "not set up yet"), skipped=source.setup_skipped,
                             **always_for(project, str(source.asset_ref or ""), what=f"the data source {source.name!r}"))
        for source in await project_sources(project)
        if source.status == SourceStatus.SETUP.value
    ]
    apps = [app for app in await WebApp.get_all({"match": {"project_id": str(project.id)}}) if app.asset_ref]
    answers = await asyncio.gather(*(step(str(app.id), "start", check=True) for app in apps))
    out += [
        SetupRequirementSpec(kind=REQUIREMENT_WEBAPP, name=str(app.name), satisfied=False, used_by=[PROJECT],
                             note=answer.detail, typeid=str(app.typeid), skipped=app.setup_skipped,
                             **always_for(project, str(app.asset_ref or ""), what=f"the web app {app.name!r}"))
        for app, answer in zip(apps, answers) if not answer.ok
    ]
    return out


def setup_run_address(project_id: str, root: str = "") -> str:
    """The run's activity address — what its questions carry (``Question.run``) and a screen claims."""
    from flow_sdk.core.setup import setup_activity_path  # noqa: PLC0415

    return setup_activity_path(root or f"project-{project_id}")


async def start_setup(project: "Project", *, ai: bool = True, root: str = "", tree: Any = None) -> str:
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

    pid = str(project.id)
    key = (pid, root)
    running = _RUNS.get(key)
    if running is None or running.done():
        tree = tree or await ProjectTree(project, ai=ai).load()
        mount = str(getattr(project, "fs_storage_mount_path", "") or "")

        async def run_setup():
            # The run's shell: what the setup does not answer itself runs here, one start per run.
            from flow_sdk.core.compute.shared_shell import SharedShell  # noqa: PLC0415

            async with SharedShell() as base:
                return await execute_setup(
                    root or tree.root, resolve_node=tree.resolve_node, resolve_op=tree.resolve_op,
                    subject_entity=f"project-{pid}", cwd=Path(mount) if mount else None,
                    shell=functools.partial(_setup_shell, inner=base),
                    # A person pressed Set up on THIS project: every node in it is theirs to run.
                    approved=True,
                )

        # Detached: the run takes minutes and asks the person questions; a plain task
        # (and a plain done-callback) would hold the Set-up request for all of it.
        task = create_detached_task(run_setup(), name=f"project-setup:{pid}:{root}")
        add_detached_done_callback(task, _log_failure)
        _RUNS[key] = task
    return setup_run_address(pid, root)


def _own_check(command: str) -> Optional[tuple[str, str, str]]:
    """``(name, project_id, deployment_id)`` when ``command`` is this interpreter's
    ``flow credentials check`` — the check a setup step runs before it asks — else None."""
    import shlex  # noqa: PLC0415
    import sys  # noqa: PLC0415

    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if argv[:5] != [sys.executable, "-m", "flow_sdk.cli.flow_cli", "credentials", "check"] or len(argv) < 6:
        return None
    options = argv[6:]
    given = dict(zip(options[::2], options[1::2]))
    return argv[5], given.get("--project", ""), given.get("--deployment", "")


async def _setup_shell(command: str, *, timeout_seconds: float, workdir: Path, extra_env: Optional[dict] = None,
                       platform: str = "", stop: Optional[asyncio.Event] = None, on_output=None,
                       on_spawn=None, fresh: bool = False, inner=None):
    """The setup's shell: its own credential checks answered here, everything else run as usual.

    Every step checks its goal before it asks, and ``flow credentials check`` as a process imports
    the CLI and, with no backend to reach, opens the database — about a second before each question,
    measured. The setup runs inside the instance the check would ask, so it asks the same
    ``credentials_status`` directly: same row (the project's own before the user's), same verdict
    (``connected`` is ready), same exit codes. Windows builds the command differently, so it keeps
    the process. Everything else goes to *inner*, the run's shell."""
    import json  # noqa: PLC0415
    import sys  # noqa: PLC0415
    import time  # noqa: PLC0415

    from flow_sdk.core.compute.exec import run_shell  # noqa: PLC0415

    own = _own_check(command) if (platform or sys.platform) != "win32" else None
    if own is None:
        return await (inner or run_shell)(command, timeout_seconds=timeout_seconds, workdir=workdir,
                                          extra_env=extra_env, platform=platform, stop=stop,
                                          on_output=on_output, on_spawn=on_spawn, fresh=fresh)
    from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415
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
    return CliResult.of_process(command, 0 if ready else int(ExitCode.NOT_YET), said,
                                duration_s=time.monotonic() - started)


def _log_failure(task: "asyncio.Task") -> None:
    """A run that raised is recorded nowhere else — say it, rather than let it vanish."""
    if not task.cancelled() and task.exception() is not None:
        logger.error("project setup run failed", exc_info=task.exception())


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
        return next((r for r in reqs if r.typeid == typeid and (r.kind != REQUIREMENT_DEPENDENCY or r.name == name)),
                    None)

    # The running ones (a live probe per web app) only when the declared ones do not name it.
    if (req := match(await collect_requirements(project)) or match(await _running_here(project))) is not None:
        return req
    raise SkipRefused(f"{name or typeid} is not something this project's setup lists")


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
    * ``always`` — the requirement stops existing: its asset leaves the project (a dependency leaves flow.json)
      and the removal is STAGED in git for the person to commit. Only a project's own asset
      (``can_skip_always``)."""
    import time  # noqa: PLC0415

    from flow_sdk.core.setup.skip_mark import write_setup_skip  # noqa: PLC0415
    from flow_sdk.schema.data_spec.asset_setup_spec import SetupSkipSpec  # noqa: PLC0415

    req = await requirement_of(project, typeid, name)
    if scope == SKIP_ALWAYS:
        if not req.can_skip_always:
            raise SkipRefused(req.why_not_always or f"{req.name} cannot be removed from this project")
        await _remove_from_project(project, req)
        return
    if scope != SKIP_LOCAL:
        raise SkipRefused(f"skip {scope!r}? it is {SKIP_LOCAL!r} or {SKIP_ALWAYS!r}")
    mark = SetupSkipSpec(at=time.time(), by=by, note=note.strip())
    if req.kind == REQUIREMENT_DEPENDENCY:
        await write_setup_skip(project, {**(project.setup_skipped or {}), req.name: mark})
    else:
        await write_setup_skip(await _record_of(req), mark)


async def unskip_requirement(project: "Project", typeid: str, *, name: str = "") -> None:
    """Undo a local skip: the requirement is listed and counted again."""
    from flow_sdk.core.setup.skip_mark import write_setup_skip  # noqa: PLC0415

    req = await requirement_of(project, typeid, name)
    if req.kind == REQUIREMENT_DEPENDENCY:
        await write_setup_skip(project, {k: v for k, v in (project.setup_skipped or {}).items() if k != req.name})
    else:
        await write_setup_skip(await _record_of(req), None)


async def _remove_from_project(project: "Project", req: SetupRequirementSpec) -> None:
    """"Skip → Always": the asset leaves the project folder and the index, each through its own delete, and git
    stages the removal."""
    from flow_sdk.assets.asset import Asset  # noqa: PLC0415
    from flow_sdk.builtin.credential_service import delete_credential  # noqa: PLC0415

    root = Path(str(project.fs_storage_mount_path or ""))
    if req.kind == REQUIREMENT_DEPENDENCY:
        await project.remove_dependency(req.name)
        await _stage(root, root / "flow.json")
        return
    record = await _record_of(req)
    folder = Path(str(record.asset_ref or ""))
    if req.kind == REQUIREMENT_PACK:
        # Its values and this machine's store pins go with it, the way a credential is always deleted.
        if not (await delete_credential(req.typeid)).removed:
            raise SkipRefused(f"{req.name}'s values could not all be removed — delete it from Credentials")
    elif req.kind == REQUIREMENT_SOURCE:
        await type(record).delete_by_id(str(record.id))  # its own path: children, row, folder
    else:
        if folder.exists():
            Asset.from_path(str(folder)).remove()
        await record.delete()
    await _stage(root, folder)


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

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
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.core.flow_command import flow_command
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.credential_contract import CredentialVarKind
from flow_sdk.schema.data_spec.project_setup_spec import (
    REQUIREMENT_GAP,
    REQUIREMENT_OAUTH,
    REQUIREMENT_PACK,
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

#: The agent every AI rung runs — "reaches one ComputeOp goal after the cheap attempt failed".
AI_AGENT = "provisioner"
PROJECT = "project"


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


def _from_row(row: "CredentialStatusRowSpec", used_by: list[str]) -> SetupRequirementSpec:
    return SetupRequirementSpec(
        kind=REQUIREMENT_PACK, name=row.name, title=row.title, setup=row.setup, help_url=row.help_url,
        setup_timeout_seconds=row.setup_timeout_seconds,
        vars=[
            SetupVarSpec(env_var=v.env_var, label=v.label, hint=v.hint, help_url=v.help_url,
                         pattern=v.pattern, secret=v.secret, file=v.kind is CredentialVarKind.FILE,
                         present=v.present)
            for v in row.vars if v.is_must
        ],
        satisfied=row.state == "connected", used_by=used_by,
        note="" if row.setup.strip() else "no setup instructions: AI Assist unavailable",
    )


def _from_template(template: "Credential", used_by: list[str]) -> SetupRequirementSpec:
    required = set(template.required_var_names())
    setup = str(getattr(template, "setup", "") or "")
    return SetupRequirementSpec(
        kind=REQUIREMENT_PACK, name=str(template.name), title=template.title or str(template.name),
        setup=setup, setup_timeout_seconds=getattr(template, "setup_timeout_seconds", None),
        help_url=template.help_url or "", declared=False, satisfied=False, used_by=used_by,
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

    out = [
        SetupRequirementSpec(kind=REQUIREMENT_OAUTH, name=provider, title=provider,
                             scopes=entry["scopes"], used_by=entry["used_by"])
        for provider, entry in sorted(oauth.items())
    ]
    by_template = {str(t.name): t for t in templates}
    for name, used_by in packs.items():
        if name in rows:
            out.append(_from_row(rows[name], used_by))
        elif name in by_template:
            out.append(_from_template(by_template[name], used_by))
        else:
            out.append(SetupRequirementSpec(
                kind=REQUIREMENT_GAP, name=name, used_by=used_by,
                note=f"names the credential {name!r}, which is neither declared nor shipped as a template",
            ))
    return out + gaps


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
        if req.kind == REQUIREMENT_OAUTH:
            scopes = [arg for s in req.scopes for arg in ("--scope", s)]
            add({
                "name": f"connect-{req.name}", "label": f"Connect {req.title or req.name}",
                "description": f"{req.name} is connected and its grant covers what {', '.join(req.used_by)} need.",
                "subkind": "cli", "exe_data": _cli("connections", "connect", req.name),
                "completion_check": _cli("connections", "test", req.name, *scopes),
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

#: The kind of run, standing in for a wizard id: ``execute_wizard`` keys the slot on it and the project.
SETUP_WIZARD_ID = "project-setup"
#: The runs this backend started, by project — one at a time per project (the slot says so too).
_RUNS: dict[str, "asyncio.Task"] = {}


def to_do(req: SetupRequirementSpec) -> bool:
    """Still needs someone: a pack with a MUST value unset, or a connection known not to hold.

    A pack is judged by its MUST values alone — ``satisfied`` (the credential's state) also waits on
    OPTIONAL ones when it has no MUST. A connection only its check can confirm (``None``) is left to
    the wizard's own check; a gap is nobody's to run."""
    if req.kind == REQUIREMENT_PACK:
        return bool(req.missing)
    if req.kind == REQUIREMENT_OAUTH:
        return req.satisfied is False
    return False


async def readiness_of(project: "Project", deployment_id: str = "") -> ProjectReadinessSpec:
    """What the footer warning reads: ready, or what is left and what nobody can set up here."""
    requirements = await collect_requirements(project, deployment_id)
    left = [r for r in requirements if to_do(r)]
    return ProjectReadinessSpec(
        project_id=str(project.id), ready=not left, to_do=left,
        gaps=[r for r in requirements if r.kind == REQUIREMENT_GAP],
    )


def setup_run_address(project_id: str) -> str:
    """The run's activity address — what its questions carry (``Question.run``) and a screen claims."""
    from flow_sdk.core.wizard.execute import activity_path_for  # noqa: PLC0415

    return activity_path_for(SETUP_WIZARD_ID, "", project_id)


async def start_setup(project: "Project", *, ai: bool = True) -> str:
    """Start the project's setup in the background and return its address at once.

    Its questions reach the app (``ask_person`` → the open tab), not a terminal. A run already going
    for this project is joined, never doubled."""
    from flow_sdk.core.wizard.execute import execute_wizard  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved  # noqa: PLC0415

    pid = str(project.id)
    running = _RUNS.get(pid)
    if running is None or running.done():
        requirements = [r for r in await collect_requirements(project) if to_do(r)]
        wizard, ops = compile_setup(pid, requirements, ai=ai)

        async def resolve(name: str) -> Optional[Resolved]:
            return Resolved(ops[name], True) if name in ops else None

        mount = str(getattr(project, "fs_storage_mount_path", "") or "")
        task = asyncio.create_task(execute_wizard(
            SETUP_WIZARD_ID, wizard, "", trusted=True, subject_entity=f"project-{pid}", target=pid,
            resolve_op=resolve, cwd=Path(mount) if mount else None,
        ))
        task.add_done_callback(_log_failure)
        _RUNS[pid] = task
    return setup_run_address(pid)


def _log_failure(task: "asyncio.Task") -> None:
    """A run that raised is recorded nowhere else — say it, rather than let it vanish."""
    if not task.cancelled() and task.exception() is not None:
        import logging  # noqa: PLC0415

        logging.getLogger(__name__).error("project setup run failed", exc_info=task.exception())


def setup_run(project_id: str) -> dict[str, Any]:
    """The run's live state: whether it is going, and its steps so far (``run.json``, no step output)."""
    from flow_sdk.core.wizard.state import read_state, run_key, strip_heavy  # noqa: PLC0415

    task = _RUNS.get(project_id)
    result = read_state(run_key(SETUP_WIZARD_ID, project_id)).get("result")
    return {
        "run": setup_run_address(project_id),
        "running": task is not None and not task.done(),
        "result": strip_heavy(result) if isinstance(result, dict) else None,
    }

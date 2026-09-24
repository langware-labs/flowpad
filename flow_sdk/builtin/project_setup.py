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

import shlex
import sys
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.credential_contract import DEFAULT_ENVIRONMENT
from flow_sdk.schema.data_spec.project_setup_spec import (
    REQUIREMENT_GAP,
    REQUIREMENT_OAUTH,
    REQUIREMENT_PACK,
    SetupRequirementSpec,
    SetupVarSpec,
    input_name,
)
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.secret_pack import SecretPack
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
        vars=[
            SetupVarSpec(env_var=v.env_var, label=v.label, hint=v.hint, help_url=v.help_url,
                         pattern=v.pattern, secret=v.secret, present=v.present)
            for v in row.vars if v.required
        ],
        satisfied=row.state == "connected", used_by=used_by,
        note="" if row.setup.strip() else "no setup instructions: AI setup unavailable",
    )


def _from_template(template: "SecretPack", environment: str, used_by: list[str]) -> SetupRequirementSpec:
    required = set(template.required_var_names(environment))
    setup = str(getattr(template, "setup", "") or "")
    return SetupRequirementSpec(
        kind=REQUIREMENT_PACK, name=str(template.name), title=template.title or str(template.name),
        setup=setup, help_url=template.help_url or "", declared=False, satisfied=False, used_by=used_by,
        vars=[
            SetupVarSpec(env_var=name, label=var.label, hint=var.hint, help_url=var.help_url,
                         pattern=var.pattern, secret=var.secret)
            for name, var in (template.vars or {}).items() if name in required
        ],
        note="" if setup.strip() else "no setup instructions: AI setup unavailable",
    )


async def _auth_of(source: "DataSource") -> Any:
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    try:
        await DataDriver.get(source.provider or "")  # an authored driver's folder loads on first use
    except Exception:  # noqa: BLE001 — a driver that cannot load needs nothing we can name
        return None
    return source._auth()


async def collect_requirements(
    project: "Project", environment: str = DEFAULT_ENVIRONMENT
) -> list[SetupRequirementSpec]:
    """Everything ``project`` needs a person (or an agent) to provide, in the order to do it:
    connections first, then credentials, then what cannot be set up here. Read-only."""
    from flow_sdk.builtin import credential_service  # noqa: PLC0415
    from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415

    status = await credentials_status(project, environment)
    rows: dict[str, "CredentialStatusRowSpec"] = {}
    for row in status.credentials:  # user first, then project: the project's own wins
        rows[row.name] = row
    templates = await credential_service.shipped_templates()

    oauth: dict[str, dict[str, list[str]]] = {}
    packs: dict[str, list[str]] = {row.name: [PROJECT] for row in status.credentials if row.scope == "project"}
    gaps: list[SetupRequirementSpec] = []

    def pack_for(env_var: str) -> Optional[str]:
        """The credential that declares ``env_var``: one in scope, else a shipped template."""
        for row in rows.values():
            if env_var in {v.env_var for v in row.vars}:
                return row.name
        return next((str(t.name) for t in templates if env_var in t.var_names()), None)

    for source in await project_sources(project):
        auth = await _auth_of(source)
        if auth is None:
            continue
        who = str(source.name or source.provider)
        if auth.connector:
            entry = oauth.setdefault(auth.connector, {"scopes": [], "used_by": []})
            entry["scopes"] += [s for s in auth.scopes if s not in entry["scopes"]]
            entry["used_by"].append(who)
            continue
        if auth.credential:
            packs.setdefault(auth.credential, []).append(who)
            continue
        # env / secrets: each name from whichever credential declares it (one source may span several).
        unclaimed = []
        for env_var in list(auth.env) or list(auth.secrets):
            name = pack_for(env_var)
            if name is None:
                unclaimed.append(env_var)
            elif who not in packs.setdefault(name, []):
                packs[name].append(who)
        if unclaimed:
            gaps.append(SetupRequirementSpec(
                kind=REQUIREMENT_GAP, name=who, used_by=[who],
                note=f"needs {', '.join(unclaimed)}, and no credential declares it — add one with `setup` instructions",
            ))

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
            out.append(_from_template(by_template[name], environment, used_by))
        else:
            out.append(SetupRequirementSpec(
                kind=REQUIREMENT_GAP, name=name, used_by=used_by,
                note=f"names the credential {name!r}, which is neither declared nor shipped as a template",
            ))
    return out + gaps


# ── 2. compile ────────────────────────────────────────────────────────────────


def _flow(*args: str, platform: str) -> str:
    """This interpreter's ``flow`` — the checks must reach the same install and instance the CLI runs in."""
    if platform == "win32":
        quoted = " ".join("'" + a.replace("'", "''") + "'" for a in args)
        return f"& '{sys.executable}' -m flow_sdk.cli.flow_cli {quoted}"
    return " ".join([shlex.quote(sys.executable), "-m", "flow_sdk.cli.flow_cli", *map(shlex.quote, args)])


def _cli(*args: str) -> dict[str, dict[str, str]]:
    return {"commands": {p: _flow(*args, platform=p) for p in ("darwin", "linux", "win32")}}


def _ask_prompt(req: SetupRequirementSpec, var: SetupVarSpec, *, ai: bool) -> str:
    lines = [f"{req.title or req.name}: {var.label or var.env_var}"]
    lines += [text for text in (var.hint, var.help_url or req.help_url) if text]
    if ai:
        lines.append("Leave it empty to let the AI set it up.")
    return "\n".join(lines)


def _ai_prompt(req: SetupRequirementSpec, project_id: str) -> str:
    """The contract around the credential's own ``setup`` (which rides the op's ``setup``)."""
    store = f"flow credentials set {req.name} --project {project_id} VAR=<value>"
    return (
        f"Set up the credential {req.title or req.name!r} ({req.name}) for this project, in development, "
        "following the instructions below.\n"
        f"Store every value with `{store}` — that command is the only place a value goes. Never print, "
        "echo or repeat a value: not in your reply, not in a file, not in a log.\n"
        "If a value needs the person (their account, a code sent to them), say exactly what they must do, and stop."
    )


def compile_setup(
    project_id: str, requirements: list[SetupRequirementSpec], *, ai: bool = True
) -> tuple[WizardSpec, dict[str, ComputeOpSpec]]:
    """The wizard for ``requirements``, and the ops it calls by name. Every step continues on failure:
    one credential nobody can provide must not stop the next one."""
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
            with_ai = ai and bool(req.setup.strip())
            check = _cli("credentials", "check", req.name, "--project", project_id)
            for var in req.missing:
                add({
                    "name": f"ask-{req.name}-{var.env_var}", "label": f"{req.title or req.name}: {var.label or var.env_var}",
                    "subkind": "ask", "output_spec_kind": "string",
                    "exe_data": {"prompt": _ask_prompt(req, var, ai=with_ai), "secret": var.secret},
                }, bind=input_name(req.name, var.env_var))
            add({
                "name": f"store-{req.name}", "label": f"Store {req.title or req.name}",
                "description": f"{req.name} has every value it needs in development.",
                "subkind": "cli", "exe_data": _cli("credentials", "set", req.name, "--project", project_id, "--from-inputs"),
                "completion_check": check,
            })
            if with_ai:
                add({
                    "name": f"ai-{req.name}", "label": f"AI setup: {req.title or req.name}",
                    "description": f"{req.name} has every value it needs in development.",
                    "subkind": "agent", "exe_data": {"agent": AI_AGENT, "prompt": _ai_prompt(req, project_id)},
                    "setup": req.setup,
                    "completion_check": check,
                })
    wizard = WizardSpec.model_validate({
        "name": "project-setup", "description": "Set up this project's connections and credentials.",
        "icon": "KeyRound", "steps": steps,
    })
    return wizard, ops

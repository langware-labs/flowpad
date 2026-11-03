"""The setup wizard of a secret manager, for one vault: install the manager's CLI, sign in, check the vault.

Every manager gets it from its own ``secret_manager.json`` (``install`` / ``login`` / ``check`` per OS,
``login_help``) — nothing here names a manager. The project setup tree shows it as the ``vault:<name>``
node; ``flow secrets setup <vault>`` and a credential's Set up button run it on their own
(:func:`run_vault_setup`): what a person who received a secret runs when this machine cannot read the
vault yet. A status or test that finds the vault unreadable names that command (:func:`store_why`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

STEPS = ("install", "login", "check")


def setup_command(vault_name: str) -> str:
    """The command that runs a vault's setup wizard on this machine."""
    return f"flow secrets setup {vault_name}"


def _on_path(binary: str, platform: str) -> str:
    return f"where {binary} >nul 2>&1" if platform == "win32" else f"command -v {binary} >/dev/null 2>&1"


def vault_setup_wizard(project_id: str, name: str, vault: Any) -> Optional[tuple[WizardSpec, dict[str, ComputeOpSpec]]]:
    """``vault:<name>``'s wizard and its ops: the manager's CLI is installed (skipped while it is on PATH), signed
    in (skipped while its check passes), then the vault checked (``flow secrets check``). None: unknown manager.
    Each command is the one :mod:`managers` runs itself, as a shell line: the manager's env, every value quoted."""
    from flow_sdk.builtin.project_setup import _cli  # noqa: PLC0415
    from flow_sdk.secrets.managers import OSES, UnknownSecretManager, get_manager, shell_line, vault_command  # noqa: PLC0415

    try:
        manager = get_manager(vault.manager)
    except UnknownSecretManager:
        return None
    title = manager.title or vault.manager
    argv = {(op, p): vault_command(vault, op, p, name=name) for op in STEPS for p in OSES}
    line = {op: {p: shell_line(*argv[op, p], p) for p in OSES} for op in STEPS}
    binary = {p: argv["check", p][0][0] for p in OSES if argv["check", p][0]}
    signed_in = {"commands": line["check"]}
    node_id = f"vault:{name}"
    steps = [
        ("install", f"Install {title}", f"{title}'s command line is on this machine.", {"commands": line["install"]},
         {"commands": {p: _on_path(b, p) for p, b in binary.items()}}),
        ("login", f"Sign in to {title}", f"This machine is signed in to {title} and can read vault {name}.",
         {"commands": line["login"]}, signed_in),
        ("check", f"Check vault {name}", f"Vault {name} is readable from this machine.",
         _cli("secrets", "check", name, "--project", project_id), signed_in),
    ]
    ops: dict[str, ComputeOpSpec] = {}
    wizard_steps = []
    for step_id, label, description, exe_data, check in steps:
        if step_id != "check" and not any(exe_data["commands"].values()):
            continue  # this manager has no such command on any OS
        op = ComputeOpSpec.model_validate({
            "name": f"{node_id}:{step_id}", "label": label, "description": description, "subkind": "cli",
            "exe_data": exe_data, "completion_check": check,
        })
        ops[op.name] = op
        wizard_steps.append({"id": step_id, "label": label, "kind": "compute", "ref": op.name})
    wizard = WizardSpec.model_validate({"name": node_id, "label": f"{title} setup for vault {name}", "steps": wizard_steps})
    return wizard, ops


async def run_vault_setup(project: Any, name: str, vault: Any, **seams: Any) -> dict[str, Any]:
    """Run ``name``'s wizard on this computer: ``{vault, ready, reason, steps: [{id, label, state, detail}]}``,
    ``state`` one of ``done`` / ``already_done`` / ``failed`` / ``not_reached``. ``ready`` is the wizard's own
    vault check — nothing runs the manager again after it. ``seams`` reach ``run_wizard`` (the terminal's asks)."""
    from flow_sdk.core.wizard.runner import Resolved, run_wizard  # noqa: PLC0415
    from flow_sdk.secrets.managers import get_manager  # noqa: PLC0415

    built = vault_setup_wizard(str(project.id), name, vault)
    if built is None:
        return {"vault": name, "ready": False, "reason": f"vault {name!r} names an unknown secret manager {vault.manager!r}", "steps": []}
    wizard, ops = built

    async def resolve(op_name: str) -> Optional[Resolved]:
        return Resolved(ops[op_name], True) if op_name in ops else None

    result = await run_wizard(
        wizard, activity_path=f"secrets-setup/{project.id}/{name}", trusted=True,
        workdir=Path(project.fs_storage_mount_path or Path.home()), resolve_op=resolve, **seams,
    )
    answers = dict(result.steps or {})
    help_text = get_manager(vault.manager).login_help
    steps = []
    for step in wizard.steps:
        answer = answers.get(step.id)
        if answer is None:
            state, detail = "not_reached", ""
        elif answer.ok:
            state, detail = ("done" if answer.ran else "already_done"), ""
        else:
            # A failed sign-in shows the manager's own instruction, not its CLI's generic error.
            state, detail = "failed", (help_text if step.id == "login" and help_text else answer.detail or "failed")
        steps.append({"id": step.id, "label": step.display_label, "state": state, "detail": detail})
    checked = answers.get("check")
    ready = checked is not None and checked.ok
    failed = next((s for s in steps if s["state"] == "failed"), None)
    reason = "" if ready else (f"{failed['label']}: {failed['detail']}" if failed else "not readable yet")
    return {"vault": name, "ready": ready, "reason": reason, "steps": steps}


def store_why(error: BaseException, vault_name: str) -> str:
    """Why a vault could not be read, in a person's words, ending in the command that fixes it."""
    reason = str(error).strip() or type(error).__name__
    return f"vault {vault_name} cannot be read here: {reason} — run `{setup_command(vault_name)}`"


def manager_missing_why(vault_name: str, vault: Any) -> str:
    """Why ``vault`` cannot be read here when its manager's CLI is not on this machine — runs nothing, so no unlock
    prompt and cheap enough for every status read. "" when the CLI is here or the manager is unknown."""
    from flow_sdk.secrets.managers import UnknownSecretManager, get_manager, tool_missing  # noqa: PLC0415

    try:
        tool = tool_missing(vault)
        title = get_manager(vault.manager).title or vault.manager
    except UnknownSecretManager:
        return ""
    return store_why(RuntimeError(f"{title}'s CLI ({tool}) is not installed on this machine"), vault_name) if tool else ""

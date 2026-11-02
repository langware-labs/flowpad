"""The setup wizard of a secret manager, for one vault: install the manager's CLI, sign in, check the vault.

Every manager gets it from its own ``secret_manager.json`` (``install`` / ``login`` / ``check`` per OS) —
nothing here names a manager. The project setup tree shows it as the ``vault:<name>`` node, and
``flow secrets setup <vault>`` runs it on its own: what a person who received a secret runs when this
machine cannot read the vault yet (``vault_problem`` says so, and names the command).
"""
from __future__ import annotations

import shlex
from typing import Any, Optional

from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec


def setup_command(vault_name: str) -> str:
    """The command that runs a vault's setup wizard on this machine."""
    return f"flow secrets setup {vault_name}"


def _on_path(binary: str, platform: str) -> str:
    return f"where {binary} >nul 2>&1" if platform == "win32" else f"command -v {binary} >/dev/null 2>&1"


def _field(manager: Any, name: str) -> Any:
    """A manager spec's field, from the spec or its dict form."""
    return manager.get(name) if isinstance(manager, dict) else getattr(manager, name, None)


def _binary(command: str) -> str:
    """The tool a command runs: its first word past any ``VAR=value`` / ``set VAR=value&&`` env prefix."""
    words = command.replace("&&", " ").split()
    while words and (words[0] == "set" or "=" in words[0]):
        words.pop(0)
    return words[0] if words else ""


def vault_commands(name: str, vault: Any) -> Optional[dict[str, dict[str, str]]]:
    """Per OS, the manager's ``install`` / ``login`` / ``check`` for this vault, its ``{vault}`` and config keys
    filled in (``{vault}`` = the config's ``vault``, else the project's name for it). None: unknown manager."""
    from flow_sdk.secrets.managers import OSES, cli_command, get_manager  # noqa: PLC0415  (lazy: managers load assets)

    try:
        manager = get_manager(vault.manager)
    except Exception:  # noqa: BLE001 — UnknownSecretManager: the caller reports it
        return None
    from flow_sdk.secrets.managers import command_argv, command_env  # noqa: PLC0415

    fill = {"vault": name, **{k: str(v) for k, v in (vault.config or {}).items()}}
    # The manager's own env (1Password's OP_ACCOUNT) rides on each command, as run_check passes it.
    env = command_env(_field(manager, "env") or {}, fill)

    def render(op: str, platform: str) -> str:
        # Each placeholder filled with itself: the template back, still to be split before it is filled.
        template = cli_command(manager, op, platform, **{k: "{" + k + "}" for k in fill}) or ""
        if not template:
            return ""
        # Split first, then fill, then quote: a value ("GTM Studio") is one argument, never shell syntax.
        argv = command_argv(template, fill)
        if platform == "win32":
            command = " ".join(f'"{a}"' if " " in a and not a.startswith('"') else a for a in argv)
        else:
            command = shlex.join(argv)
        if not env:
            return command
        if platform == "win32":
            return "".join(f"set {k}={v}&& " for k, v in env.items()) + command
        return " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items()) + " " + command

    return {op: {p: render(op, p) for p in OSES} for op in ("install", "login", "check")}


def vault_setup_wizard(project_id: str, name: str, vault: Any) -> Optional[tuple[WizardSpec, dict[str, ComputeOpSpec]]]:
    """``vault:<name>``'s wizard and its ops: the manager's CLI is installed (skipped while it is on PATH), signed
    in (skipped while its check passes), then the vault checked (``flow secrets check``). None: unknown manager."""
    from flow_sdk.builtin.project_setup import _cli  # noqa: PLC0415
    from flow_sdk.secrets.managers import OSES, get_manager  # noqa: PLC0415

    commands = vault_commands(name, vault)
    if commands is None:
        return None
    title = _field(get_manager(vault.manager), "title") or vault.manager
    node_id = f"vault:{name}"
    binary = {p: _binary(commands["check"][p]) for p in OSES}
    manager_check = {"commands": commands["check"]}
    specs = []
    if any(commands["install"].values()):
        specs.append({
            "name": f"{node_id}:install", "label": f"Install {title}",
            "description": f"{title}'s command line is on this machine.", "subkind": "cli",
            "exe_data": {"commands": commands["install"]},
            "completion_check": {"commands": {p: _on_path(binary[p], p) for p in OSES if binary[p]}},
        })
    if any(commands["login"].values()):
        specs.append({
            "name": f"{node_id}:login", "label": f"Sign in to {title}",
            "description": f"This machine is signed in to {title} and can read vault {name}.",
            "subkind": "cli", "exe_data": {"commands": commands["login"]}, "completion_check": manager_check,
        })
    specs.append({
        "name": f"{node_id}:check", "label": f"Check vault {name}",
        "description": f"Vault {name} is readable from this machine.", "subkind": "cli",
        "exe_data": _cli("secrets", "check", name, "--project", project_id), "completion_check": manager_check,
    })
    ops: dict[str, ComputeOpSpec] = {}
    steps = []
    for spec in specs:
        op = ComputeOpSpec.model_validate(spec)
        ops[op.name] = op
        steps.append({"id": op.name.rsplit(":", 1)[1], "label": op.label, "kind": "compute", "ref": op.name})
    wizard = WizardSpec.model_validate({"name": node_id, "label": f"{title} setup for vault {name}", "steps": steps})
    return wizard, ops


def store_why(error: BaseException, vault_name: str) -> str:
    """Why a vault could not be read, in a person's words, ending in the command that fixes it."""
    reason = str(error).strip() or type(error).__name__
    return f"vault {vault_name} cannot be read here: {reason} — run `{setup_command(vault_name)}`"


def manager_missing_why(project: Any, vault_name: str) -> str:
    """Why a vault cannot be read here when its manager's CLI is not on this machine at all — the one check cheap
    enough for every status read (no call to the manager, so no unlock prompt). "" when the CLI is here or unknown."""
    import shutil  # noqa: PLC0415

    from flow_sdk.builtin.credential_store import vaults_of  # noqa: PLC0415
    from flow_sdk.secrets.managers import current_os, get_manager  # noqa: PLC0415

    vault = vaults_of(project).get(vault_name)
    if vault is None:
        return ""
    commands = vault_commands(vault_name, vault)
    binary = _binary(commands["check"][current_os()]) if commands else ""
    if not binary or shutil.which(binary):
        return ""
    title = _field(get_manager(vault.manager), "title") or vault.manager
    return store_why(RuntimeError(f"{title}'s CLI ({binary}) is not installed on this machine"), vault_name)


def login_help(vault: Any) -> str:
    """The manager's own words for a failed sign-in (``login_help``); "" when it has none."""
    from flow_sdk.secrets.managers import get_manager  # noqa: PLC0415

    try:
        return str(_field(get_manager(vault.manager), "login_help") or "")
    except Exception:  # noqa: BLE001 — unknown manager: no hint
        return ""

"""``flow secrets ...`` — a project's vaults: how a credential's values travel between people.

    flow secrets managers                                   — the secret managers installed here
    flow secrets vault list                                 — this project's vaults
    flow secrets vault add <name> --manager M --config k=v  — add (or replace) a vault
    flow secrets vault remove <name>                        — forget a vault (its secrets stay in the manager)
    flow secrets check <vault>                              — is the vault reachable from here? (exit code)
    flow secrets publish <cred> --vault V                   — this computer's values into the vault
    flow secrets fetch [cred]                               — the vaults into this computer's store
    flow secrets grant <vault> <email>                      — give a teammate read access
    flow secrets active                                     — the vault in use here, and how its manager behaves
    flow secrets status|open|close [vault]                  — is its access open here; open it; seal it
    flow secrets vault default <name>                       — make a vault the project's default
    flow secrets run NAME[,NAME] -- <command>               — run a command with values read from the active vault

A value moves only local → vault (publish) and vault → local store (fetch); ``run`` hands values to one
command's environment and saves nothing. Every command prints names, never a value. Over HTTP when a backend runs, in-process when none does — the same
``builtin/credential_service`` functions either way.
"""
from __future__ import annotations

import os
from typing import Any, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import discover_port, fail, get_graph_json, ok, parse_config_pairs, post_graph_json
from flow_sdk.cli.commands.credentials_cmd import EXIT_NOT_YET, _here, _project_id, _status, _url
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

secrets_app = typer.Typer(
    name="secrets",
    help="A project's vaults in its secret managers: publish, fetch and grant credential values. Never prints a value.",
    add_completion=False,
    no_args_is_help=True,
)
vault_app = typer.Typer(name="vault", help="List, add and remove the project's vaults.", no_args_is_help=True)
secrets_app.add_typer(vault_app, name="vault")

_ProjectOpt = Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")]


def _refuse(code: str, message: str) -> None:
    """Exit on a refusal; a sealed vault names the command that opens it."""
    sealed = code == "sealed"
    fail(EXIT_NOT_YET, code or "REFUSED", message, {"remediation": ["flow secrets open"]} if sealed else None)


def _refused(status: int, body: dict) -> None:
    _refuse(str((body.get("data") or {}).get("error_code") or ""), str(body.get("message") or f"HTTP {status}"))


def _call(verb: str, payload: dict, *, needs_project: bool = True, get: bool = False) -> Any:
    """``credentials/<verb>`` over the backend, else the service function in this process."""
    port = discover_port(required=False)
    if needs_project:
        payload["project_id"] = _project_id(port, payload.get("project_id"))
        if not payload["project_id"]:
            fail(int(ExitCode.REFUSED), "NO_PROJECT", "run inside a project folder or pass --project")
    if port is not None:
        if get:
            return get_graph_json(f"{_url(port)}/{verb}", params=payload or None, on_error=_refused)
        return post_graph_json(f"{_url(port)}/{verb}", payload, on_error=_refused)

    async def here() -> Any:
        from flow_sdk.builtin import credential_service as svc  # noqa: PLC0415

        pid, vault = payload.get("project_id") or "", payload.get("vault") or ""
        try:
            if verb == "managers":
                return {"managers": svc.list_managers()}
            if verb == "vaults":
                return await svc.list_vaults(pid)
            if verb == "vault-set":
                return await svc.set_vault(pid, payload["name"], payload["spec"])
            if verb == "vault-remove":
                return await svc.set_vault(pid, payload["name"], None)
            if verb == "vault-default":
                return await svc.set_default_vault(pid, payload["name"])
            if verb == "active":
                return await svc.active_vault(pid)
            if verb == "vault-access":
                return await svc.vault_access(pid, vault, payload.get("scope") or "", payload.get("change") or "")
            if verb == "vault-read":
                return await svc.vault_read(pid, payload["names"])
            if verb == "vault-check":
                return await svc.vault_check(pid, vault)
            if verb == "publish":
                return await svc.publish(payload["name"], pid, vault)
            if verb == "fetch":
                return await svc.fetch(payload["name"], pid)
            if verb == "grant":
                return await svc.grant(pid, vault, payload["email"])
        except svc.CredentialError as e:
            _refuse(e.code, str(e))
        raise ValueError(f"unknown secrets verb {verb!r}")

    return _here(here())


@secrets_app.command("managers")
def managers_cmd() -> None:
    """The secret managers this Flowpad can use, with their config fields."""
    ok(_call("managers", {}, needs_project=False, get=True))


@vault_app.command("list")
def vault_list_cmd(project: _ProjectOpt = None) -> None:
    """The project's vaults: name → manager and config. Never a value."""
    ok(_call("vaults", {"project_id": project}, get=True))


@vault_app.command("add")
def vault_add_cmd(
    name: Annotated[str, typer.Argument(help="The vault's name in this project (e.g. team).")],
    manager: Annotated[str, typer.Option("--manager", help="The secret manager (see `flow secrets managers`).")],
    config: Annotated[Optional[list[str]], typer.Option("--config", help="A manager config field, key=value (repeatable).")] = None,
    project: _ProjectOpt = None,
) -> None:
    """Add (or replace) the project's vault NAME, held in MANAGER."""
    ok(_call("vault-set", {"project_id": project, "name": name, "spec": {"manager": manager, "config": parse_config_pairs(config, "BAD_CONFIG", "--config takes key=value")}}))


@vault_app.command("remove")
def vault_remove_cmd(
    name: Annotated[str, typer.Argument(help="The vault to forget.")],
    project: _ProjectOpt = None,
) -> None:
    """Forget the project's vault NAME. The secrets in the manager are not touched."""
    ok(_call("vault-remove", {"project_id": project, "name": name}))


@vault_app.command("default")
def vault_default_cmd(
    name: Annotated[str, typer.Argument(help="The vault to make the default (\"\" clears it: the first by name).")],
    project: _ProjectOpt = None,
) -> None:
    """Make NAME the project's default vault: the one its agents read a missing secret from."""
    ok(_call("vault-default", {"project_id": project, "name": name}))


@secrets_app.command("active")
def active_cmd(project: _ProjectOpt = None) -> None:
    """The vault in use here — the project's default, else this instance's — whether this computer can use
    it, and its manager's own instructions. Never a value."""
    port = discover_port(required=False)
    pid = _project_id(port, project) or ""
    ok(_call("active", {"project_id": pid}, needs_project=False, get=True))


def _access(vault: Optional[str], project: Optional[str], change: str) -> None:
    """``vault``'s access (default: the vault in use here), after ``change``. Exit 1 unless it ends where asked."""
    from flow_sdk.secrets.managers import VaultAccess  # noqa: PLC0415

    pid = _project_id(discover_port(required=False), project) or ""
    result = _call("vault-access", {"project_id": pid, "vault": vault or "", "change": change}, needs_project=False)
    ok(result)
    if result.get("state") != (VaultAccess.SEALED if change == "close" else VaultAccess.OPEN):
        raise typer.Exit(EXIT_NOT_YET)


_VaultArg = Annotated[Optional[str], typer.Argument(help="The vault (default: the one in use here).")]


@secrets_app.command("status")
def status_cmd(vault: _VaultArg = None, project: _ProjectOpt = None) -> None:
    """Is VAULT's access open on this computer (open / sealed / not_installed / unknown)? Asks nothing of the person."""
    _access(vault, project, "")


@secrets_app.command("open")
def open_cmd(vault: _VaultArg = None, project: _ProjectOpt = None) -> None:
    """Open VAULT's access on this computer: its manager's sign-in, which may ask the person in its app or browser."""
    _access(vault, project, "open")


@secrets_app.command("close")
def close_cmd(vault: _VaultArg = None, project: _ProjectOpt = None) -> None:
    """Seal VAULT's access on this computer, when its manager can. Exit 1 when it is still open."""
    _access(vault, project, "close")


@secrets_app.command("run", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def run_cmd(
    names: Annotated[str, typer.Argument(help="The variables the command needs, comma-separated (STRIPE_API_KEY,DATABASE_URL).")],
    command: Annotated[list[str], typer.Argument(help="The command to run, after `--`.")],
    project: _ProjectOpt = None,
) -> None:
    """Run COMMAND with NAMES in its environment: each from this environment when it is there, else read from
    the active vault. Nothing is printed and nothing is saved; the command's own exit code is returned."""
    wanted = [n.strip() for n in names.split(",") if n.strip() and not os.environ.get(n.strip())]
    # Read by the backend when one runs: it holds the manager's access, and this process is a session of its own.
    pid = _project_id(discover_port(required=False), project) or ""
    values = (_call("vault-read", {"project_id": pid, "names": wanted}, needs_project=False) or {}).get("values") or {} if wanted else {}
    try:
        os.execvpe(command[0], command, {**os.environ, **values})
    except OSError as e:
        fail(int(ExitCode.NOT_FOUND), "NO_COMMAND", f"cannot run {command[0]!r}: {e}")


@secrets_app.command("check")
def check_cmd(vault: Annotated[str, typer.Argument(help="The vault to check.")], project: _ProjectOpt = None) -> None:
    """Is VAULT reachable from this computer (manager installed and signed in)? Exit 1 when not."""
    result = _call("vault-check", {"project_id": project, "vault": vault})
    ok(result)
    if not result.get("ready"):
        raise typer.Exit(EXIT_NOT_YET)


@secrets_app.command("publish")
def publish_cmd(
    name: Annotated[str, typer.Argument(help="The credential whose values to publish (e.g. bright_data).")],
    vault: Annotated[str, typer.Option("--vault", help="The project's vault to publish into.")],
    project: _ProjectOpt = None,
) -> None:
    """Copy this computer's values of NAME into VAULT and record each variable's ref in its
    credential.json. Names only are printed. Exit 1 when a value is missing here."""
    result = _call("publish", {"project_id": project, "name": name, "vault": vault})
    ok(result)
    if result.get("not_here"):
        raise typer.Exit(EXIT_NOT_YET)


@secrets_app.command("fetch")
def fetch_cmd(
    name: Annotated[Optional[str], typer.Argument(help="The credential to fetch (default: every one with a vault ref).")] = None,
    project: _ProjectOpt = None,
) -> None:
    """Fetch values from the project's vaults into this computer's store (.env.local by default).
    Names only are printed. Exit 1 when a value is missing or a vault denied access."""
    if name:
        results = [_call("fetch", {"project_id": project, "name": name})]
    else:
        # The project resolves once, not once per credential.
        pid = _project_id(discover_port(required=False), project)
        rows = (_status(pid) or {}).get("credentials") or []
        names = sorted({row["name"] for row in rows if row.get("scope") == "project" and row.get("name")})
        results = []
        for cred in names:
            try:
                results.append({"name": cred, **_call("fetch", {"project_id": pid, "name": cred})})
            except typer.Exit:
                # One credential that names no vault (or holds no values) does not stop the rest.
                continue
    ok(results[0] if name else {"credentials": results})
    if any(r.get("missing") or r.get("denied") for r in results):
        raise typer.Exit(EXIT_NOT_YET)


@secrets_app.command("grant")
def grant_cmd(
    vault: Annotated[str, typer.Argument(help="The vault to share.")],
    email: Annotated[str, typer.Argument(help="The teammate's email in that secret manager.")],
    project: _ProjectOpt = None,
) -> None:
    """Give EMAIL read access to VAULT, through the secret manager's own sharing."""
    ok(_call("grant", {"project_id": project, "vault": vault, "email": email}))


@secrets_app.command("setup")
def setup_cmd(vault: Annotated[str, typer.Argument(help="The vault to set up (e.g. team).")], project: _ProjectOpt = None) -> None:
    """Run VAULT's secret-manager setup wizard on this computer: install the manager's CLI, sign in, check the
    vault — each step skipped when it already holds. Exit 1 until the vault is readable here."""
    import asyncio  # noqa: PLC0415

    code = asyncio.run(_setup(vault, project))
    if code:
        raise typer.Exit(code)


async def _setup(vault_name: str, project_id: Optional[str]) -> int:
    from flow_sdk.builtin.credential_store import vaults_of  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.cli.commands.project_cmd import _terminal_answers  # noqa: PLC0415
    from flow_sdk.secrets.setup_wizard import run_vault_setup  # noqa: PLC0415

    project = await (Project.get_by_id(project_id) if project_id else Project.find_by_cwd(os.getcwd()))
    if project is None:
        fail(2, "NO_PROJECT", "no project here: cd into a project folder or pass --project")
    vaults = vaults_of(project)
    if vault_name not in vaults:
        fail(int(ExitCode.NOT_FOUND), "UNKNOWN_VAULT", f"project {project.name} declares no vault {vault_name!r} "
             f"(declared: {', '.join(sorted(vaults)) or 'none'})")
    # In this process: a sign-in may ask on this terminal.
    async with _terminal_answers() as seams:
        result = await run_vault_setup(project, vault_name, vaults[vault_name], **seams)
    marks = {"done": "✓", "already_done": "✓", "failed": "✗", "not_reached": "·"}
    for step in result["steps"]:
        said = {"done": "done", "already_done": "already done", "not_reached": "not reached"}.get(step["state"], step["detail"])
        typer.echo(f"  {marks[step['state']]}  {step['label']}: {said}")
    typer.echo(f"Vault {vault_name} is readable here." if result["ready"] else f"Vault {vault_name} is not readable yet: {result['reason']}")
    return int(ExitCode.OK if result["ready"] else ExitCode.NOT_YET)

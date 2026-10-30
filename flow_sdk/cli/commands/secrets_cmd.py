"""``flow secrets ...`` — a project's vaults: how a credential's values travel between people.

    flow secrets managers                                   — the secret managers installed here
    flow secrets vault list                                 — this project's vaults
    flow secrets vault add <name> --manager M --config k=v  — add (or replace) a vault
    flow secrets vault remove <name>                        — forget a vault (its secrets stay in the manager)
    flow secrets check <vault>                              — is the vault reachable from here? (exit code)
    flow secrets publish <cred> --vault V                   — this computer's values into the vault
    flow secrets fetch [cred]                               — the vaults into this computer's store
    flow secrets grant <vault> <email>                      — give a teammate read access

A value moves only local → vault (publish) and vault → local store (fetch). Every command prints
names, never a value. Over HTTP when a backend runs, in-process when none does — the same
``builtin/credential_service`` functions either way.
"""
from __future__ import annotations

from typing import Any, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import discover_port, fail, get_graph_json, ok, parse_config_pairs, post_graph_json
from flow_sdk.cli.commands.credentials_cmd import EXIT_NOT_YET, _here, _project_id, _refused, _status, _url
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
            if verb == "vault-check":
                return await svc.vault_check(pid, vault)
            if verb == "publish":
                return await svc.publish(payload["name"], pid, vault)
            if verb == "fetch":
                return await svc.fetch(payload["name"], pid)
            if verb == "grant":
                return await svc.grant(pid, vault, payload["email"])
        except svc.CredentialError as e:
            fail(EXIT_NOT_YET, e.code or "REFUSED", str(e))
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

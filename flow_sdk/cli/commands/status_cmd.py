"""``flow status`` — the status record, as tables. Facts only; funding is ``flow llm list``.

Asks the RUNNING backend when there is one: the hub login lives in that server's socket, so
an in-process read in a CLI would report a signed-in box as offline. With no backend, the
record is built here and the hub honestly reads as not confirmed.
"""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

import typer

from flow_sdk.cli.commands._common import discover_port, fail, local_request

EXIT_CHECK_FAILED = 1
EXIT_INVALID_ARG = 2
EXIT_CONNECTION_ERROR = 5

status_app = typer.Typer(
    name="status",
    help="What is on this box: harnesses (installed, login, account), stored keys, FlowPad account.",
    add_completion=False,
    invoke_without_command=True,
)


def _fetch(refresh: bool, kinds: list[str] | None = None) -> dict:
    """The record; ``refresh`` re-discovers ``kinds`` (every harness when ``None``) first."""
    port = discover_port(required=False)
    if port is None:
        from flow_sdk.core.status import build_status, refresh_status  # noqa: PLC0415

        async def run() -> dict:
            if refresh:
                await refresh_status(kinds)
            return (await build_status()).model_dump(mode="json")

        return asyncio.run(run())
    url = f"http://127.0.0.1:{port}/api/v1/graph/compute_node/@local/status"
    try:
        resp = (
            local_request("POST", f"{url}/refresh", json={"kinds": kinds} if kinds else {}, timeout=120)
            if refresh
            else local_request("GET", url, timeout=30)
        )
        body = resp.json()
    except Exception as exc:  # noqa: BLE001 — any transport failure is the same answer
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {exc}")
    if resp.status_code != 200 or str(body.get("status", "")).upper() != "SUCCESS":
        fail(EXIT_CONNECTION_ERROR, "REFUSED", str(body.get("message") or f"HTTP {resp.status_code}"))
    return body.get("data") or {}


def _table(rows: list[list[str]]) -> str:
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip() for r in rows)


def _render(status: dict) -> str:
    hub = status["hub"]
    hub_line = f"FlowPad: {hub['login'].replace('_', ' ')}"
    if hub.get("email"):
        hub_line += f" ({hub['email']})"
    if hub.get("error"):
        hub_line += f" — {hub['error']}"
    default = status.get("default_harness") or ""
    harness_rows = [["HARNESS", "INSTALLED", "LOGIN", "ACCOUNT"]]
    for h in status["harnesses"]:
        account = " · ".join(x for x in (h["account"].get("identity"), h["account"].get("plan")) if x) or "—"
        install = h["install"].replace("_", " ")
        if h.get("version"):
            install += f" {h['version']}"
        name = h["worker_type"] + (" *" if h["kind"] == default else "")
        harness_rows.append([name, install, h["login"].replace("_", " ").replace("n a", "n/a"), account])
    key_rows = [["PROVIDER", "STORED"]] + [[k["provider"], "yes" if k["stored"] else "no"] for k in status["keys"]]
    return "\n\n".join([hub_line, _table(harness_rows), _table(key_rows), "* default harness"])


def _check_target(spec: str) -> str:
    """The harness a ``--check`` names: ``install:<harness>``, where ``<harness>`` is a driver name
    (``claude``), a capability kind, or ``default`` (the user's default harness)."""
    fact, _, name = spec.partition(":")
    if fact != "install" or not name:
        fail(EXIT_INVALID_ARG, "INVALID_ARG", f"unknown check {spec!r}; use install:<harness>")
    return name


def _kind_for(name: str, status: dict | None = None) -> str:
    """A ``--check`` name as a capability kind, ``""`` when it names no harness."""
    from flow_sdk.flowpad_types.vendors import vendor_by, vendor_or_none  # noqa: PLC0415

    if name == "default":
        return str((status or {}).get("default_harness") or "")
    vendor = vendor_or_none(name) or vendor_by("capability_kind", name)
    return vendor.capability_kind if vendor is not None else ""


def _check(status: dict, kind: str) -> bool:
    """Is that harness's CLI here (installed or built in)."""
    return any(h["kind"] == kind and h["install"] in ("installed", "built_in") for h in status["harnesses"])


@status_app.callback()
def status(
    json_output: Annotated[bool, typer.Option("--json", help="Print the record as JSON.")] = False,
    refresh: Annotated[bool, typer.Option("--refresh", help="Re-discover CLIs and re-probe logins first.")] = False,
    check: Annotated[
        str, typer.Option("--check", help="Exit 0 if the fact holds, 1 if not. Supports install:<harness>.")
    ] = "",
) -> None:
    if check:
        # A check right after an install re-discovers only the harness it asks about: the one
        # fact that can have changed, without re-probing every other vendor's login.
        name = _check_target(check)
        kind = _kind_for(name, _fetch(False) if name == "default" else None)
        if not kind:
            fail(EXIT_INVALID_ARG, "INVALID_ARG", f"no harness named {name!r}")
        raise typer.Exit(0 if _check(_fetch(refresh, [kind]), kind) else EXIT_CHECK_FAILED)
    record = _fetch(refresh)
    typer.echo(json.dumps(record, indent=2) if json_output else _render(record))

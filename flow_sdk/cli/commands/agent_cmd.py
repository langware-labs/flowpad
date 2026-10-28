"""``flow agent deploy <agent>`` — put an agent on a machine of its own, through the running app.

    flow agent deploy researcher                     # production, on an e2b machine
    flow agent deploy researcher --environment staging
    flow agent deploy researcher --provider gcp_vm   # on a provider the hub offers
    flow agent providers                             # the providers the hub offers

The app answers once the deploy is taken on, and its steps — the readiness gate included — run after that,
reported on the agent's ``deploy`` activity. By default the command blocks, printing each report on the agent as
it arrives, until the deploy ends: exit 0 when it completed, 1 when it failed. ``--no-blocking`` prints where the
activity reports and exits. Names only are ever printed.
"""
from __future__ import annotations

import json
from typing import NoReturn, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    backend_frames,
    discover_port,
    fail,
    get_graph_json,
    graph_url,
    ok,
    post_graph_json,
    run_async,
)
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

agent_app = typer.Typer(name="agent", help="Deploy an agent to a machine of its own.", add_completion=False, no_args_is_help=True)

def _refused(status: int, body: dict) -> NoReturn:
    data = body.get("data") or {}
    code = str(data.get("code") or "REFUSED")
    fail(int(ExitCode.NOT_YET) if code == "not_ready" else int(ExitCode.REFUSED), code, str(body.get("message") or f"HTTP {status}"), data)


def _agent_id(port: int, agent: str) -> str:
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415

    if is_valid_uuid(agent.removeprefix("agent-")):
        return agent.removeprefix("agent-")
    rows = get_graph_json(graph_url(port, "agent"), params={"filter": json.dumps({"name": agent})}, on_error=_refused)
    matches = [r for r in rows if isinstance(r, dict) and r.get("id")] if isinstance(rows, list) else []
    if len(matches) != 1:
        fail(int(ExitCode.NOT_FOUND), "NOT_FOUND", f"{len(matches)} agents named {agent!r}; pass its id")
    return str(matches[0]["id"])


@agent_app.command("deploy")
def deploy(
    agent: Annotated[str, typer.Argument(help="The agent's name or id.")],
    environment: Annotated[Optional[str], typer.Option("--environment", help="The placement's environment (default: production).")] = None,
    provider: Annotated[str, typer.Option("--provider", help="The compute provider to deploy on; `flow agent providers` lists them.")] = "e2b",
    blocking: Annotated[bool, typer.Option("--blocking/--no-blocking", help="Wait for the deploy to end, printing each step as it reports.")] = True,
) -> None:
    """Deploy AGENT to a machine of its own; blocks until it ends unless --no-blocking."""
    port = discover_port(required=True)
    agent_id = _agent_id(port, agent)
    url = graph_url(port, f"agent/{agent_id}/deploy")
    body = {"environment": environment, "provider": provider}
    if not blocking:
        data = post_graph_json(url, body, on_error=_refused)
        ok({"agent_id": agent_id, "activity": (data or {}).get("activity")})
        return
    run_async(_deploy_and_follow(port, agent_id, url, body))


async def _deploy_and_follow(port: int, agent_id: str, url: str, body: dict) -> None:
    """Deploy, and print every report of the agent's ``deploy`` activity until it ends. The socket watches the
    agent BEFORE the deploy is sent: a step reported before the watch is a report this command never gets."""
    from uuid import uuid4  # noqa: PLC0415

    from flow_sdk.schema.data_spec.activity_spec import TERMINAL  # noqa: PLC0415

    connection_id = f"flow-cli-{uuid4().hex[:8]}"
    subject = f"agent-{agent_id}"

    async def start() -> None:
        post_graph_json(graph_url(port, f"agent/{agent_id}/watch"), {"connection_id": connection_id}, on_error=_refused)
        post_graph_json(url, body, on_error=_refused)

    async for frame in backend_frames(port, {"flow_data_msg"}, on_connected=start, connection_id=connection_id):
        data = frame.get("flow_data") or {}
        report = data.get("attributes") or {}
        if frame.get("to_entity") != subject or data.get("element_type") != "progress_report" or report.get("path") != "deploy":
            continue
        state = report.get("state")
        ok({"agent_id": agent_id, "state": state, "message": report.get("message"),
            "steps": {step["name"]: step["state"] for step in report.get("children") or []}})
        if state in {s.value for s in TERMINAL}:
            if state != "completed":
                fail(int(ExitCode.NOT_YET), "DEPLOY_FAILED", report.get("message") or f"the deploy {state}")
            return
    fail(int(ExitCode.NOT_YET), "DEPLOY_NOT_FINISHED", "the connection to the app closed before the deploy ended")


@agent_app.command("providers")
def providers() -> None:
    """List the compute providers the signed-in hub offers for deployments."""
    port = discover_port(required=True)
    names = get_graph_json(graph_url(port, "deployment/providers"), on_error=_refused)
    ok({"providers": names if isinstance(names, list) else []})

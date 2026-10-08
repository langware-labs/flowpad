"""The generic Flowpad diagnose -- the mechanical checks of the flow-diagnose catalog, no LLM.

Each check answers findings; the status is the worst of them. Ids are the catalog's
(``.claude/skills/flow-diagnose/references/catalog.md``) where one matches. It changes nothing:
repairing is the Diagnose button's agent step, which reads this diagnosis as its starting point.
The runner adds the environment and log tails, so this answers only what it found.
"""

from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path

from flow_sdk.diagnose import DiagnosisFinding, DiagnosisSpec, DiagnosisStatus, FlowContextSpec, progress
from flow_sdk.diagnose.baseline import newest_boot_log, tail

#: Below this much free disk under ~/.flow the DB and logs start failing to write.
LOW_DISK_BYTES = 1 << 30
_ERROR_LINE = re.compile(r"\b(ERROR|CRITICAL)\b|Traceback \(most recent call last\)")


def check_backend(settings) -> list[DiagnosisFinding]:
    from flow_sdk.server.launch import check_server_health

    progress("checking the backend")
    if not settings.server_json_path.exists():
        return [
            DiagnosisFinding(
                id="A3",
                severity="error",
                title=f"Instance '{settings.instance_name}' is not running",
                detail="There is no server.json for this instance. Start Flowpad (or `flow start`).",
                evidence=str(settings.server_json_path),
            )
        ]
    # The monitor's own probe: it carries the cookie-gate header a gated instance requires.
    if check_server_health(settings.port):
        return []
    return [
        DiagnosisFinding(
            id="A2",
            severity="error",
            title="The backend does not answer its health check",
            detail="Flowpad's backend is not responding. Restart Flowpad.",
            evidence=f"http://127.0.0.1:{settings.port}/health/status",
        )
    ]


def check_lock(settings) -> list[DiagnosisFinding]:
    from flow_sdk.pid_probe import pid_is_alive
    from flow_sdk.singleton_lock import is_held, read_pid

    progress("checking the server lock")
    pid = read_pid(settings.server_pid_path)
    # A stop or a crash leaves server.lock and server.pid behind, harmless by contract
    # (``singleton_lock.release``): only a lock still HELD for a process that is gone blocks a start.
    if pid is None or pid_is_alive(pid) or not is_held(settings.server_lock_path):
        return []
    return [
        DiagnosisFinding(
            id="A2.lock",
            severity="error",
            title="A stale server lock is left by a process that is gone",
            detail=f"server.lock belongs to PID {pid}, which is not running; it can block startup.",
            evidence=str(settings.server_lock_path),
        )
    ]


def check_disk(settings) -> list[DiagnosisFinding]:
    progress("checking free disk")
    try:
        free = shutil.disk_usage(settings.flow_home).free
    except OSError:
        return []
    if free >= LOW_DISK_BYTES:
        return []
    return [
        DiagnosisFinding(
            id="A2.disk",
            severity="error",
            title="The disk is almost full",
            detail=f"Only {free // (1 << 20)} MB free where Flowpad keeps its data.",
            evidence=str(settings.flow_home),
        )
    ]


def check_ui_bundle(_settings) -> list[DiagnosisFinding]:
    import flow_sdk

    progress("checking the UI bundle")
    package = Path(flow_sdk.__file__).parent
    assets = package / "server" / "static" / "assets"
    if not assets.is_dir() or (package.parent / "ui").is_dir():
        # A source checkout serves the UI from Vite; only an installed wheel must carry the bundle.
        return []
    if any(assets.glob("*.js")):
        return []
    return [
        DiagnosisFinding(
            id="B5",
            severity="error",
            title="The installed UI bundle is empty",
            detail="The package was built without its UI; reinstall Flowpad.",
            evidence=str(assets),
        )
    ]


async def check_hub() -> list[DiagnosisFinding]:
    from flow_sdk.cli.auth.hub_login import hub_auth_available
    from flow_sdk.cloud_client.transport.hub_http import get_info, hub_base_url

    progress("checking the hub and sign-in")
    hub = hub_base_url()  # None when no hub is configured, and in Local privacy mode
    if not hub:
        return []
    out: list[DiagnosisFinding] = []
    if await get_info() is None:
        out.append(
            DiagnosisFinding(
                id="C6",
                severity="warning",
                title="The hub is unreachable",
                detail="Sharing, sync and messages wait until it is back; local work is unaffected.",
                evidence=hub,
            )
        )
    if not hub_auth_available():  # keychain-safe: a background sweep never prompts
        out.append(DiagnosisFinding(id="C6.signed_out", severity="warning", title="Not signed in to the hub"))
    return out


def check_logs(settings) -> list[DiagnosisFinding]:
    progress("reading recent errors")
    newest = newest_boot_log(settings.logs_dir / "server")
    if newest is None:
        return []
    errors = [line for line in tail(newest, 400) if _ERROR_LINE.search(line)]  # tail() redacts
    if not errors:
        return []
    return [
        DiagnosisFinding(
            id="log.errors",
            severity="warning",
            title=f"{len(errors)} error line(s) in the recent server log",
            detail=errors[-1][:500],
            evidence=str(newest),
        )
    ]


def _status(findings: list[DiagnosisFinding]) -> DiagnosisStatus:
    if any(f.severity == "error" for f in findings):
        return DiagnosisStatus.NEEDS_ACTION
    if findings:
        return DiagnosisStatus.INFORMATIONAL
    return DiagnosisStatus.OK


async def diagnose(ctx: FlowContextSpec) -> DiagnosisSpec:
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    local = (check_backend, check_lock, check_disk, check_ui_bundle, check_logs)
    # The hub's answer and the backend's are both waits on the network: take them together.
    hub, *rest = await asyncio.gather(check_hub(), *(asyncio.to_thread(check, settings) for check in local))
    findings = [f for found in (*rest, hub) for f in found]
    worst = next((f for f in findings if f.severity == "error"), findings[0] if findings else None)
    return DiagnosisSpec(
        status=_status(findings),
        title=worst.title if worst else "Flowpad looks healthy",
        summary=(
            "; ".join(f.title for f in findings)
            if findings
            else "The backend answers, the hub is reachable and the recent logs hold no errors."
        ),
        symptoms=ctx.user_report,
        findings=findings,
    )

"""`report` graph action — email a diagnosis to the Flowpad team.

The Home-Feed / diagnose-modal "Report issue" button calls this null-entity graph
action the normal way — ``dataManager.callAction(new ActionInfo('report', null,
null, 'POST'))`` → ``/api/v1/graph/report`` — with ``{diagnosis_id}`` in the body.

It loads the ``flowpad_diagnosis`` record, pulls out the interesting parts (what
happened, the user's own words, who/when/which OS), and hands a ready-to-send
payload to the **hub**, which holds the SendGrid key and sends the mail to
``diagnosis@langware.ai``.

Why relay through the hub instead of calling SendGrid here: this backend runs
**on the user's machine** (pip-installed desktop app), so any API key shipped with
it would be readable by every user. The key stays server-side on the hub; this
action just POSTs the report to an **unauthenticated** hub endpoint (mirroring the
public ``GET /health/version`` probe), so it works whether or not the user is
cloud-logged-in.
"""
from __future__ import annotations

import logging
import platform as _platform
from datetime import datetime, timezone

import httpx

from flow_sdk.actions.action_registry import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse, ApiFailResponse

logger = logging.getLogger(__name__)

# Fixed inbox the diagnosis reports go to. The hub may override/enforce this; we
# send it explicitly so the intent is visible in the payload.
REPORT_TO_EMAIL = "diagnosis@langware.ai"


def _compose_text(fields: dict[str, str]) -> str:
    """Assemble a readable plaintext body from the interesting parts, skipping
    anything empty so the hub can relay it as-is (no formatting logic hub-side)."""
    sections = [
        ("What the user reported", fields.get("user_report")),
        ("Summary", fields.get("summary")),
        ("Symptoms (observed)", fields.get("symptoms")),
        ("Root cause", fields.get("rca")),
        ("Fix", fields.get("fix")),
    ]
    meta = [
        ("User", fields.get("user")),
        ("When", fields.get("occurred_at")),
        ("OS", fields.get("os")),
        ("App version", fields.get("app_version")),
        ("Diagnosis id", fields.get("diagnosis_id")),
    ]
    out: list[str] = []
    for label, val in sections:
        if val:
            out.append(f"## {label}\n{val.strip()}")
    meta_lines = [f"{label}: {val}" for label, val in meta if val]
    if meta_lines:
        out.append("## Details\n" + "\n".join(meta_lines))
    return "\n\n".join(out)


@action.post(action_name="report", types=None)
async def report() -> ApiResponse:
    request_info = get_current_request_info()
    body = (await request_info.get_post_data() if request_info else None) or {}
    diag_id = (body.get("diagnosis_id") or "").strip() if isinstance(body, dict) else ""
    if not diag_id:
        return ApiFailResponse(message="diagnosis_id is required", status_code=400)

    # Load the diagnosis record (same path the diagnose feed action uses).
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.types import EntityType

    diag_cls = SchemaRegistry.get_entity_cls(EntityType.FLOWPAD_DIAGNOSIS)
    diag = await diag_cls.get_by_id(diag_id) if diag_cls else None
    if diag is None:
        return ApiFailResponse(message=f"diagnosis {diag_id} not found", status_code=404)

    # Who: best-effort identity (works signed-out — git config / OS / desktop default).
    from flow_sdk.server.routes.bootstrap import get_email, get_name

    name, email = get_name(), get_email()
    user_label = f"{name} <{email}>" if name and email else (email or name or "unknown")

    try:
        from flow_sdk._version import __version__ as app_version
    except Exception:  # noqa: BLE001
        app_version = None

    fields = {
        "diagnosis_id": diag_id,
        "title": getattr(diag, "title", None) or "",
        "summary": getattr(diag, "summary", None) or "",
        "symptoms": getattr(diag, "symptoms", None) or "",
        "rca": getattr(diag, "rca", None) or "",
        "fix": getattr(diag, "fix", None) or "",
        "user_report": getattr(diag, "user_report", None) or "",
        "user": user_label,
        # created_date may be a datetime — coerce to str so the JSON body serializes.
        "occurred_at": str(getattr(diag, "created_date", None) or ""),
        "os": _platform.platform(),
        "app_version": app_version or "",
    }

    title = fields["title"] or "Issue report"
    payload = {
        "to": REPORT_TO_EMAIL,
        "subject": f"[Flowpad diagnosis] {title}",
        "reported_at": datetime.now(timezone.utc).isoformat(),
        "text": _compose_text(fields),
        **fields,
    }

    # Relay to the hub (holds the SendGrid key). Unauthenticated, non-graph route —
    # mirrors the public health probe — so it works whether or not the user is
    # signed in. hub_public_url() returns None in Local (private) mode / when no hub
    # is configured (no outbound HTTP allowed); surface that as a clean failure.
    from flow_sdk.cloud_client.transport.hub_http import hub_public_url

    url = hub_public_url("diagnosis-report")
    if not url:
        return ApiFailResponse(
            message="Reporting is unavailable offline (no hub configured).",
            status_code=503,
        )
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=httpx.Timeout(15))
    except Exception as e:  # noqa: BLE001
        logger.warning("[report] POST %s transport error: %s", url, e)
        return ApiFailResponse(message="Could not reach the reporting service.", status_code=502)

    if resp.status_code != 200:
        logger.warning("[report] POST %s returned %s: %s", url, resp.status_code, resp.text[:300])
        return ApiFailResponse(message="The reporting service rejected the report.", status_code=502)

    logger.info("[report] emailed diagnosis %s to %s via hub", diag_id, REPORT_TO_EMAIL)
    return ApiSuccessResponse(data={"sent": True, "diagnosis_id": diag_id})

"""Credentials HTTP action — a thin wrapper over ``builtin/credential_service``.

Addressed as ``/api/v1/graph/compute_node/@local/credentials/...``:

  GET    /credentials/status?project_id=   → CredentialsStatusSpec (names only)
  POST   /credentials/save                 → body {scope, project_id?, typeid?, manifest, values?} → summary
  POST   /credentials/values               → body {typeid, values} → summary
  POST   /credentials/set                  → body {name, project_id?, values, choice?} → summary (declares from its template)
  POST   /credentials/delete               → body {typeid} → {deleted, kept}

A refusal carries ``data.error_code`` when the condition is fixable (a
committable ``.env.local``, a disabled vault). A value is never returned.
"""
from __future__ import annotations

import logging

from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _summary(spec) -> dict:
    """What a caller needs after a write: which credential, and where it lives."""
    return {
        "typeid": str(spec.typeid),
        "name": str(spec.name or ""),
        "title": spec.title or str(spec.name or ""),
        "scope": spec.scope,
        "project_id": spec.project_id,
    }


@action.all(action_name="credentials", methods=["get", "post"], types="all")
async def credentials_action() -> ApiResponse:
    from flow_sdk.builtin.credential_service import (  # noqa: PLC0415
        CredentialError,
        declare_credential,
        delete_credential,
        get_project,
        save_credential,
        set_credential_by_name,
        set_credential_values,
    )

    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")

    method = request_info.request.method.upper()
    sub_path = (request_info.sub_path or "").strip("/")
    if sub_path.startswith("sealed/"):
        return await _sealed(method, sub_path[len("sealed/"):], request_info.request)
    try:
        if method == "GET" and sub_path == "status":
            from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415

            params = request_info.request.query_params
            project_id = params.get("project_id")
            project = await get_project(project_id)
            if project_id and project is None:
                return ApiFailResponse(message="project not found")
            try:
                status = await credentials_status(project, params.get("deployment_id") or "")
            except ValueError as e:
                return ApiFailResponse(message=str(e))
            return ApiSuccessResponse(data=status.model_dump(mode="json"))
        if method == "GET" and sub_path in ("managers", "vaults"):
            from flow_sdk.builtin import credential_service as svc  # noqa: PLC0415

            if sub_path == "managers":
                return ApiSuccessResponse(data={"managers": svc.list_managers()})
            return ApiSuccessResponse(data=await svc.list_vaults(request_info.request.query_params.get("project_id") or ""))
        if method == "POST":
            payload = await request_info.get_post_data() or {}
            if sub_path == "save":
                manifest = dict(payload.get("manifest") or {})
                # An older client still says where values live in the manifest: that is the
                # deployment's now, so it becomes the store choice. Per-environment overrides
                # have no meaning here any more (the boot lift moved existing ones).
                legacy_store = manifest.pop("value_store", None)
                manifest.pop("environments", None)
                spec = await save_credential(
                    manifest=manifest,
                    scope=payload.get("scope"),
                    project_id=payload.get("project_id"),
                    typeid=payload.get("typeid"),
                    values=payload.get("values") or {},
                    deployment_id=payload.get("deployment_id"),
                    store=payload.get("store") or legacy_store,
                    auto_declare=payload.get("auto_declare") is True,
                )
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "values":
                spec = await set_credential_values(
                    payload.get("typeid") or "", payload.get("values") or {}, payload.get("deployment_id")
                )
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "set":
                spec = await set_credential_by_name(
                    payload.get("name") or "", payload.get("values") or {},
                    project_id=payload.get("project_id"), deployment_id=payload.get("deployment_id"),
                    choice=payload.get("choice") or "", read_files=bool(payload.get("read_files")),
                )
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "declare":
                spec = await declare_credential(payload.get("manifest") or {}, project_id=payload.get("project_id") or "")
                return ApiSuccessResponse(data=_summary(spec))
            # On a deployment's machine: the hub places the deployment's values (``credential_service``).
            if sub_path == "drop":
                from flow_sdk.builtin.credential_service import drop_folder  # noqa: PLC0415

                return ApiSuccessResponse(data={"dir": str(drop_folder())})
            if sub_path == "place":
                from flow_sdk.builtin.credential_service import place_values  # noqa: PLC0415

                return ApiSuccessResponse(data=await place_values(
                    payload.get("deployment_id") or "", payload.get("project_id") or "", payload.get("file") or "",
                    payload.get("environment") or "",
                ))
            if sub_path == "connections":
                from flow_sdk.builtin.credential_service import place_connections  # noqa: PLC0415

                return ApiSuccessResponse(data=await place_connections(payload.get("file") or ""))
            if sub_path == "unplace":
                from flow_sdk.builtin.credential_service import unplace_values  # noqa: PLC0415

                return ApiSuccessResponse(data=await unplace_values(
                    payload.get("deployment_id") or "", payload.get("project_id") or "", list(payload.get("names") or []),
                    payload.get("environment") or "",
                ))
            if sub_path == "teardown":
                # The deployment's machine is about to go: its sources undo what they set up at providers.
                from flow_sdk.builtin.credential_service import teardown_sources  # noqa: PLC0415

                return ApiSuccessResponse(data={"sources": await teardown_sources()})
            if sub_path == "use-mine":
                from flow_sdk.builtin.credential_service import use_mine  # noqa: PLC0415

                names = payload.get("names")
                return ApiSuccessResponse(data=await use_mine(payload.get("deployment_id") or "", list(names) if names else None))
            # The project's vaults (``credential_service``): values between people, names only.
            if sub_path == "test":
                from flow_sdk.builtin import credential_service as svc  # noqa: PLC0415

                return ApiSuccessResponse(data=await svc.test_credential(payload.get("name") or "", payload.get("project_id") or ""))
            if sub_path in ("publish", "fetch", "vault-check", "grant", "vault-set", "vault-remove"):
                from flow_sdk.builtin import credential_service as svc  # noqa: PLC0415

                pid, vault = payload.get("project_id") or "", payload.get("vault") or ""
                if sub_path == "publish":
                    return ApiSuccessResponse(data=await svc.publish(payload.get("name") or "", pid, vault))
                if sub_path == "fetch":
                    return ApiSuccessResponse(data=await svc.fetch(payload.get("name") or "", pid))
                if sub_path == "vault-check":
                    return ApiSuccessResponse(data=await svc.vault_check(pid, vault))
                if sub_path == "grant":
                    return ApiSuccessResponse(data=await svc.grant(pid, vault, payload.get("email") or ""))
                spec = payload.get("spec") if sub_path == "vault-set" else None
                return ApiSuccessResponse(data=await svc.set_vault(pid, payload.get("name") or "", spec))
            if sub_path == "audit":
                from flow_sdk.builtin.credential_sweep import sweep_local  # noqa: PLC0415

                result = await sweep_local(
                    project_id=payload.get("project_id") or "",
                    names=payload.get("names") or [],
                    roots=payload.get("roots") or [],
                )
                return ApiSuccessResponse(data=result.model_dump(mode="json"))
            if sub_path == "delete":
                return ApiSuccessResponse(data=(await delete_credential(payload.get("typeid") or "")).model_dump(mode="json"))
        return ApiFailResponse(message=f"Unknown {method} credentials/{sub_path}")
    except CredentialError as e:
        # A refusal is the caller's to fix — never a server error.
        return ApiFailResponse(
            message=str(e),
            data={"error_code": e.code} if e.code else None,
            status_code=409 if e.code == "exists" else 400,
        )
    except Exception as e:
        logger.error("credentials action error [%s %s]: %s", method, sub_path, e)
        return ApiFailResponse(message=str(e))


# ── secured transfer (``flow_sdk/secrets/sealed_transfer.py``) ──────────────
#
#   GET  /credentials/sealed/state?conversation_id=       → {incoming, sent} — the conversation's card, one hub read
#   GET  /credentials/sealed/{receivers|incoming|sent}?conversation_id=
#   GET  /credentials/sealed/device                       → this device's key id (expert view)
#   POST /credentials/sealed/seal     {typeid, conversation_id, recipients?}  (Flowpad's own UI only)
#   POST /credentials/sealed/fill     {conversation_id, message_id, project_id?}  (Flowpad's own UI only)
#   POST /credentials/sealed/decline  {conversation_id, message_id}
#   POST /credentials/sealed/publish  {rotate?}           → publish / rotate / withdraw this device's key

_SEALED_GET = {"state": "state", "receivers": "receivers", "incoming": "incoming", "sent": "sent_status"}
#: Sharing or filling in values is a person's click — never a worker, the CLI or a served app.
_FROM_THE_UI_ONLY = {"seal", "fill"}


async def _sealed(method: str, verb: str, request) -> ApiResponse:
    from flow_sdk.secrets import sealed_transfer as st  # noqa: PLC0415
    from flow_sdk.secrets.sealed import SealedError  # noqa: PLC0415
    from flow_sdk.server.middleware.cookie_gate_middleware import from_flowpad_ui  # noqa: PLC0415

    try:
        if method == "GET":
            if verb == "device":
                return ApiSuccessResponse(data=st.key_info())
            if verb in _SEALED_GET:
                fn = getattr(st, _SEALED_GET[verb])
                return ApiSuccessResponse(data=await fn(request.query_params.get("conversation_id") or ""))
            return ApiFailResponse(message=f"Unknown GET credentials/sealed/{verb}")
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        if verb in _FROM_THE_UI_ONLY and not from_flowpad_ui(request):
            return ApiFailResponse(message="sharing or filling in values takes a click in Flowpad",
                                   data={"error_code": "human_only"}, status_code=403)  # fmt: skip
        conv, msg = body.get("conversation_id") or "", body.get("message_id") or ""
        post = {
            "seal": lambda: st.seal_credential(body.get("typeid") or "", conv, [str(r) for r in body.get("recipients") or []]),
            "fill": lambda: st.fill(conv, msg, project_id=body.get("project_id")),
            "decline": lambda: st.decline(conv, msg),
        }
        if verb in post:
            return ApiSuccessResponse(data=await post[verb]())
        if verb == "publish":
            advert = await st.publish_device_key(rotate=bool(body.get("rotate")))
            return ApiSuccessResponse(data={**st.key_info(), **({"key_id": advert.key_id} if advert else {})})
        return ApiFailResponse(message=f"Unknown POST credentials/sealed/{verb}")
    except SealedError as e:
        return ApiFailResponse(message=str(e), data={"error_code": e.code}, status_code=400)
    except Exception as e:  # noqa: BLE001
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

        if isinstance(e, HubError):
            return ApiFailResponse(message=str(e), data={"error_code": "hub"}, status_code=502)
        logger.error("credentials sealed error [%s %s]: %s", method, verb, type(e).__name__)
        return ApiFailResponse(message="secured transfer failed")

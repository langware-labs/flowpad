"""``/api/v1/remote-control/*`` — this machine's Remote control section (``core/compute/access_keys``).

- ``GET  status``                   -> ``Status``
- ``POST request``                  -> ``{url, request_id, node_typeid, expires_at}`` — registers this machine as a
  hub node if it is not one yet, and answers the hub page that adds a key for it
- ``POST refresh``                  -> ``Status`` — reads the person's keys from the hub and applies the accept rule
- ``POST allow   {credential_id}``  -> ``Status``
- ``POST remove  {credential_id}``  -> ``Status``
- ``POST turn-on {hours}``          -> ``{url, expires_at}`` — a five-minute challenge and the hub page that runs
  the passkey prompt for it; 400 for hours outside 1, 3, 10, 24; 409 ``add an access key first``
- ``POST confirm {assertion}``      -> ``Status`` — verifies the passkey's answer HERE, with the public key this
  machine accepted, and opens remote control for the hours asked; 400 ``the fingerprint check failed`` or
  ``this request expired, turn on again``
- ``POST lock    {}``               -> ``Status`` — off at once; always allowed

``Status = {available, reason, on, open_until, hours, last_off, hours_options, node_typeid, machine_name, keys,
request}``; ``reason`` is ``signed_out``, ``private`` or ``identity`` when a person is not signed in to a hub here,
and then nothing can be added or turned on. ``on`` is true only until ``open_until``.

Called by this machine's own UI, behind the cookie gate like every local route. After a change of ``on`` or of
the accepted-key count the node is told (``compute_node/<id>/remote-control``): best effort, the local state stands.
The window running out is such a change: every route records it first, and a task reports it at the deadline.
"""

from __future__ import annotations

import asyncio
import json
import logging
import platform
from datetime import datetime
from typing import Any, Optional
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from flow_sdk.core.compute import access_key_verify, access_keys, hub_node
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/remote-control")

SIGNED_OUT = "signed_out"
PRIVATE = "private"
IDENTITY = "identity"

MACHINES_PAGE = "/dock/hub/machines"

CHECK_FAILED = "the fingerprint check failed"
REQUEST_EXPIRED = "this request expired, turn on again"

DEFAULT_PORTS = {"http": 80, "https": 443}

#: The task that reports the window running out, and the deadline it waits for.
_deadline_task: asyncio.Task | None = None
_deadline_for: str | None = None


def _ok(data: dict) -> JSONResponse:
    return JSONResponse(status_code=200, content=ApiSuccessResponse(data=data).model_dump(mode="json"))


def _fail(status_code: int, message: str, data: dict | None = None) -> JSONResponse:
    body = ApiFailResponse(message=message, status_code=status_code, data=data).model_dump(mode="json")
    return JSONResponse(status_code=status_code, content=body)


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def unavailable_reason() -> Optional[str]:
    """Why Remote control cannot be set up here, or None when a person is signed in to a hub."""
    from flow_sdk.cli.app_config import get_principal  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_base_url  # noqa: PLC0415
    from flow_sdk.core.compute.it_session import person_signed_in  # noqa: PLC0415

    if not hub_base_url():
        return PRIVATE
    if person_signed_in():
        return None
    return IDENTITY if (get_principal() or {}).get("type") == "identity" else SIGNED_OUT


def _status(state: dict, reason: Optional[str]) -> dict:
    return access_keys.status_view(
        state,
        reason=reason,
        hostname=platform.node().split(".")[0] or "my-machine",
        now=access_keys.utc_now(),
    )


def _switch(state: dict) -> tuple[bool, int]:
    return access_keys.is_on(state, access_keys.utc_now()), access_keys.accepted_count(state)


async def _push_state(state: dict, hub: hub_node.HubCalls | None = None) -> None:
    """Tell the hub node the ``{on, key_count}`` of ``state``. A failure is logged; the local state stands."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    on, key_count = _switch(state)
    node_typeid = state["node_typeid"]
    if not node_typeid:
        return
    node_id = node_typeid.removeprefix(f"{EntityType.COMPUTE_NODE.value}-")
    try:
        await (hub or HubProxy).call(
            "POST", EntityType.COMPUTE_NODE, node_id, "remote-control", payload={"on": on, "key_count": key_count}
        )
    except Exception as e:  # noqa: BLE001 — a display cache on the hub; never a reason to fail the local change
        logger.warning("remote control: could not report on=%s keys=%s to node %s: %s", on, key_count, node_id, e)


async def report_to_node(before: tuple[bool, int], state: dict, hub: hub_node.HubCalls | None = None) -> None:
    """Tell the hub node when ``on`` or the key count of ``state`` moved from ``before``, and keep the deadline
    task in step."""
    if _switch(state) != before:
        await _push_state(state, hub)
    _watch_deadline(state)


async def _expire(hub: hub_node.HubCalls | None = None) -> dict:
    """Record a window that ran out and report it — once, whichever route or task gets here first.

    Answers the state as it is now: the one read of a request.
    """
    state, expired = access_keys.expire_if_due(access_keys.utc_now())
    if expired:
        await _push_state(state, hub)
    _watch_deadline(state)
    return state


async def _changed(before: tuple[bool, int], state: dict) -> JSONResponse:
    """The answer to a change that left ``state``: the hub node is told what moved from ``before``, then the Status."""
    await report_to_node(before, state)
    return _ok(_status(state, unavailable_reason()))


def _seconds_left(open_until: str) -> float:
    return (datetime.fromisoformat(open_until) - access_keys.utc_now()).total_seconds()


async def _report_at(open_until: str) -> None:
    left = _seconds_left(open_until)
    while left > 0:  # the loop's clock is not the wall clock: wake, look again
        await asyncio.sleep(left)
        left = _seconds_left(open_until)
    await _expire()


def _watch_deadline(state: dict) -> None:
    """One task waits for the ``open_until`` of ``state``; a changed or closed window replaces or cancels it.

    Best effort: with no running loop nothing is scheduled, and the next route call records the expiry.
    """
    global _deadline_task, _deadline_for  # noqa: PLW0603
    open_until = state["open_until"] if _switch(state)[0] else None
    if open_until == _deadline_for and (open_until is None or (_deadline_task and not _deadline_task.done())):
        return
    if _deadline_task and not _deadline_task.done():
        try:
            _deadline_task.cancel()
        except RuntimeError:  # its loop is closed; the task died with it
            pass
    _deadline_task, _deadline_for = None, None
    if open_until is None:
        return
    try:
        _deadline_task = asyncio.get_running_loop().create_task(_report_at(open_until), name="remote-control-deadline")
    except RuntimeError:
        return
    _deadline_for = open_until


def hub_web_origin() -> tuple[str, str, str] | None:
    """``(the hub web URL, its origin, its host)``, or None with no hub.

    The origin (``scheme://host[:port]``, a default port left out, as a browser writes it) is where the passkey
    prompt runs; the host is the passkey's RP ID.
    """
    from flow_sdk.cloud_client.client import ApiConfig  # noqa: PLC0415

    base = ApiConfig.from_env().app_base_url
    if not base:
        return None
    parts = urlsplit(base)
    host = (parts.hostname or "").lower()
    if not parts.scheme or not host:
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    literal = f"[{host}]" if ":" in host else host
    with_port = port is not None and port != DEFAULT_PORTS.get(parts.scheme.lower())
    return base, f"{parts.scheme.lower()}://{literal}{f':{port}' if with_port else ''}", host


async def _ensure_node() -> str:
    """This machine's hub node typeid, registering the machine when it is not a node yet. Raises the hub's error."""
    from flow_sdk.fs_store.type_id import type_id_str  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    node = await hub_node.ensure_node_strict(hub_node.machine_id(), get_instance_settings().port)
    node_typeid = type_id_str(EntityType.COMPUTE_NODE.value, str(node["id"]))
    access_keys.set_node(node_typeid, str(node.get("name") or "") or None)
    return node_typeid


def _assertion(value: Any) -> dict | None:
    """The assertion as an object: given as one, as its JSON text, or as base64url of that text (the address form)."""
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    try:
        if not text.startswith("{"):
            raw = access_key_verify.base64url_bytes(text)
            if raw is None:
                return None
            text = raw.decode("utf-8")
        parsed = json.loads(text)
    except ValueError:  # not UTF-8, or not JSON
        return None
    return parsed if isinstance(parsed, dict) else None


def _unavailable(reason: str) -> JSONResponse:
    return _fail(409, f"remote control is unavailable: {reason}", {"reason": reason})


def _hub_failed(what: str, error: Exception) -> JSONResponse:
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

    logger.warning("remote control: %s: %s", what, error)
    return _fail(502, error.user_message() if isinstance(error, HubError) else f"{what}: {error}")


@router.get("/status")
async def status():
    return _ok(_status(await _expire(), unavailable_reason()))


@router.post("/request")
async def request_key():
    await _expire()
    reason = unavailable_reason()
    if reason is not None:
        return _unavailable(reason)
    web = hub_web_origin()
    if web is None:
        return _unavailable(PRIVATE)
    try:
        node_typeid = await _ensure_node()
    except Exception as e:  # noqa: BLE001 — the hub's reason is the answer; nothing was stored
        return _hub_failed("could not register this machine on the hub", e)
    made = access_keys.new_request()
    query = urlencode({"access-key-request": made["id"], "node": node_typeid})
    return _ok(
        {
            "url": f"{web[0]}{MACHINES_PAGE}?{query}",
            "request_id": made["id"],
            "node_typeid": node_typeid,
            "expires_at": made["expires_at"],
        }
    )


@router.post("/refresh")
async def refresh():
    from flow_sdk.cli.app_config import get_user  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    state = await _expire()
    reason = unavailable_reason()
    user = get_user() if reason is None else None
    if not user:
        return _ok(_status(state, reason or SIGNED_OUT))
    try:
        answer = await HubProxy.call("GET", BuiltinEntityType.USER, str(user["id"]), "access_keys")
    except Exception as e:  # noqa: BLE001 — the store is left as it was
        return _hub_failed("could not read your access keys from the hub", e)
    hub_keys = answer.get("keys") if isinstance(answer, dict) else None
    if not isinstance(hub_keys, list):
        return _fail(502, "the hub did not answer a list of access keys")
    before = access_keys.read_state()  # read again: the hub call was awaited, the store may have moved
    after = access_keys.apply_hub_keys(hub_keys, before["node_typeid"], access_keys.utc_now())
    return await _changed(_switch(before), after)


@router.post("/allow")
async def allow(request: Request):
    credential_id = (await _body(request)).get("credential_id")
    if not isinstance(credential_id, str) or not credential_id:
        return _fail(400, "credential_id is required")
    before = _switch(await _expire())
    reason = unavailable_reason()
    if reason is not None:
        return _unavailable(reason)
    after = access_keys.allow(credential_id)
    if after is None:
        return _fail(404, "no such key waiting to be allowed")
    return await _changed(before, after)


@router.post("/remove")
async def remove(request: Request):
    credential_id = (await _body(request)).get("credential_id")
    if not isinstance(credential_id, str) or not credential_id:
        return _fail(400, "credential_id is required")
    before = _switch(await _expire())
    after = access_keys.remove(credential_id)
    if after is None:
        return _fail(404, "no such key on this machine")
    return await _changed(before, after)


@router.post("/turn-on")
async def turn_on(request: Request):
    try:
        hours = access_keys.checked_hours((await _body(request)).get("hours"))
    except access_keys.BadHours:
        return _fail(400, f"hours: one of {', '.join(map(str, access_keys.HOURS_OPTIONS))}")
    state = await _expire()
    reason = unavailable_reason()
    if reason is not None:
        return _unavailable(reason)
    web = hub_web_origin()
    if web is None:
        return _unavailable(PRIVATE)
    if not access_keys.accepted_count(state):
        return _fail(409, "add an access key first")
    node_typeid = state["node_typeid"]
    if not node_typeid:  # an accepted key does not imply a registered node: allowing a pending key registers none
        try:
            node_typeid = await _ensure_node()
        except Exception as e:  # noqa: BLE001 — the hub's reason is the answer; no challenge was made
            return _hub_failed("could not register this machine on the hub", e)
    try:
        made = access_keys.new_turn_on(hours, access_keys.utc_now())
    except access_keys.NoAcceptedKey as e:
        return _fail(409, str(e))
    query = urlencode({"remote-control-confirm": made["challenge"], "node": node_typeid, "hours": hours})
    return _ok({"url": f"{web[0]}{MACHINES_PAGE}?{query}", "expires_at": made["expires_at"]})


@router.post("/confirm")
async def confirm(request: Request):
    assertion = _assertion((await _body(request)).get("assertion"))
    state = await _expire()
    if assertion is None:
        logger.warning("remote control: confirm refused: the assertion is not a JSON object")
        return _fail(400, CHECK_FAILED)
    now = access_keys.utc_now()
    challenges = access_keys.live_challenges(state, now)
    if not challenges:
        return _fail(400, REQUEST_EXPIRED)
    key = state["keys"].get(str(assertion.get("id") or ""))
    if not key or key.get("state") != access_keys.ACCEPTED:
        logger.warning("remote control: confirm refused: the key that answered is not accepted on this machine")
        return _fail(400, CHECK_FAILED)
    web = hub_web_origin()
    if web is None:
        return _unavailable(PRIVATE)
    before = _switch(state)
    try:
        challenge, sign_count = access_key_verify.verify_passkey_assertion(
            key, assertion, challenges=challenges, rp_id=web[2], origins=[web[1]]
        )
        after = access_keys.open_with(challenge, now, credential_id=key["credential_id"], sign_count=sign_count)
    except access_key_verify.AssertionRefused as e:  # the reason stays in the log, never in the answer
        logger.warning("remote control: confirm refused (rp id %s, origin %s): %s", web[2], web[1], e)
        return _fail(400, REQUEST_EXPIRED if e.reason == access_key_verify.NO_LIVE_CHALLENGE else CHECK_FAILED)
    except access_keys.ChallengeGone:
        return _fail(400, REQUEST_EXPIRED)
    except access_keys.NoAcceptedKey as e:
        logger.warning("remote control: confirm refused: %s", e)
        return _fail(400, CHECK_FAILED)
    return await _changed(before, after)


@router.post("/lock")
async def lock():
    before = _switch(await _expire())
    return await _changed(before, access_keys.lock(access_keys.utc_now()))

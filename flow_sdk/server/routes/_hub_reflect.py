"""Which graph requests the hub answers, and folding its answers into local rows.

The TS SDK only ever talks to the local server. ``decide`` is the ONE rule for whether a
graph request is answered here or by the hub (read from the raw path, before the desktop
parses it); ``route_to_hub`` (HTTP) and ``route_ws_to_hub`` (WS ``rest_api_msg``) apply it
and forward through ``HubProxy`` verbatim — the desktop graph path IS the hub's. A JSON
answer about rows this box keeps is then folded into them (``mirror_answer``) without
changing the answer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.cloud_client.shared.errors import HubError

logger = logging.getLogger(__name__)


# Looked up at CALL time, never bound at import: an import that happens while some caller has
# these patched would otherwise freeze the patched function into this module for good.
def is_logged_in() -> bool:
    from flow_sdk.cli.auth import hub_login  # noqa: PLC0415

    return hub_login.is_logged_in()


def is_local_mode() -> bool:
    from flow_sdk.instance_settings import privacy_mode  # noqa: PLC0415

    return privacy_mode.is_local_mode()


def scope_body_to_assignee_fields(entity: Entity, body: dict[str, Any]) -> dict[str, Any]:
    """Narrow an outbound entity update to what the ASSIGNEE is allowed to change.

    A shared entity is ONE hub row, and ``Entity.is_stale`` is whole-row LWW —
    while the client PUTs its entire snapshot (``FlowSync/store.ts``). So the
    assignee flipping a status ships their whole (possibly stale) copy, and the
    hub row — then the owner's row, then the owner's ``task.md`` via
    ``owns_main_ref`` — takes the assignee's title and body. Measured live
    2026-07-28: the owner's rename and rewrite were both reverted by a status
    click.

    Declared per type as ``TypeInfo.assignee_owned_fields``; types that declare
    nothing are untouched. Self-assignment is not narrowed — reporter and
    assignee being the same person means there is only one author.

    This is the single chokepoint, deliberately: filtering here means the bad
    values never reach the hub, so no inbound guard has to guess which peer
    authored an op (hub payloads carry no author).
    """
    if not body:
        return body
    from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    owned = tuple(getattr(SchemaRegistry.get(entity.get_type()), "assignee_owned_fields", ()) or ())
    if not owned:
        return body
    assignee = normalize_email(getattr(entity, "assignee", None) or "")
    if not assignee:
        return body
    reporter = normalize_email(getattr(entity, "reporter", None) or "")
    if reporter and reporter == assignee:
        return body

    # The CLOUD identity, not ``User.get_local()`` — that one is the desktop user
    # (whoever owns the machine), and on any instance the two differ. Read from
    # the plaintext instance config rather than ``load_credentials()``: this runs
    # on every reflected PUT (i.e. every debounced editor save of an assigned
    # task), and the credential store costs ~5 file reads + 4 Fernet decrypts per
    # call, blocking the event loop. ``cloud_login`` writes the same user record
    # to both.
    from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

    me = normalize_email((get_user() or {}).get("email"))
    if not me or me != assignee:
        return body

    scoped = {k: v for k, v in body.items() if k in owned}
    dropped = sorted(set(body) - set(scoped))
    if dropped:
        logger.info(
            "[hub-reflect] %s-%s: assignee update scoped to %s (dropped %s)",
            entity.get_type(),
            entity.id,
            list(scoped),
            dropped,
        )
    return scoped


def should_reflect_to_hub(entity: Entity | None, hub_reflect: bool, action_name: str | None = None) -> bool:
    """True iff this action call should be forwarded to the hub instead of run locally.

    Reflection is **opt-in per call** via ``hub_reflect`` (the ``Hub-Reflect`` header,
    or the ``hub_reflect`` field on a WS ``rest_api_msg``), default False. The action
    no longer carries a ``reflect`` marker — the request decides. The remaining gates
    are unchanged: the entity must have a hub counterpart and the user must be logged
    in. (Type eligibility is enforced downstream by ``reflect_to_hub`` →
    ``_entity_type_enum`` → ``HubError`` → quiet local fallback.)

    ``fs`` is the one action that reflects on ``remote`` ALONE, without the opt-in.
    Entity FILES must be on the hub by the time any other member asks for them —
    the writer may be offline by then, and unlike a field there is no other copy
    to fall back to. Making it a per-caller courtesy would mean a caller that
    forgets the header (the TS ``fsService`` does not set it, nor do agents or
    the CLI) silently strands the bytes on one machine. Entity FIELD writes stay
    opt-in and already get it automatically — ``FlowSync/store.ts`` sends the
    header whenever ``entity.remote``.
    """
    return (
        (bool(hub_reflect) or action_name == "fs")
        and entity is not None
        and getattr(entity, "remote", False) is True
        and is_logged_in()
        and not is_local_mode()
    )


def _entity_type_enum(entity: Entity) -> BuiltinEntityType | None:
    """Map ``entity.type`` (string) to the ``BuiltinEntityType`` enum.

    Returns None when the type isn't a builtin (e.g. plugin-defined entities)
    — those have no hub representation so reflection is a no-op.
    """
    try:
        return BuiltinEntityType(entity.type)
    except ValueError:
        return None


# Sentinel: the hub side is done, but the LOCAL handler must STILL run. Every
# other action reflects as a *replacement* (the hub's response is the answer);
# entity files are the write-through case — the bytes go to the hub AND stay in
# local storage, which is the cache the headless agent reads by local path.
REFLECT_CONTINUE_LOCAL = object()


def _hub_serves_git_bytes(entity: Entity) -> bool:
    """Whether Hub can serve this entity's bytes from Git at all.

    Only a git-publishable type (``cloud_file_transport == "git"``) gets a Git
    mount in Hub's storage resolver. A ``project`` carries a ``git_origin`` too
    — the repo its folder was cloned from — but Hub has no Git storage for it,
    so forwarding its VFS reads there answers every browse with a bare
    "Invalid file system operation" while the authoritative checkout is sitting
    on this machine.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(getattr(entity, "type", None) or "")
    return info is not None and info.git_publishable


def is_git_backed_remote_fs(entity: Entity | None, action_name: str | None) -> bool:
    """Whether an entity FS request must be replaced by a Hub request.

    Git is authoritative for a published asset, so falling through to a local
    cache after a rejected/offline Hub call would report a false success and
    fork the asset. That authority is what the type gate encodes: it holds only
    where Hub actually mounts the asset's Git tree — everywhere else the local
    checkout IS the authority and the read stays here. This gate intentionally
    does not require the caller to be logged in: an unauthenticated proxy
    attempt must fail at Hub, never mutate local state.
    """

    return bool(
        action_name == "fs"
        and entity is not None
        and getattr(entity, "remote", False) is True
        and getattr(entity, "origin", None) is not None
        and _hub_serves_git_bytes(entity)
        and not is_local_mode()
    )


_HUB_ONLY_OFFLINE = "{type} exists only on Flowpad Cloud; you're offline or signed out."

# The most rows of a hub list answer folded into local copies per call.
_MIRROR_LIST_CAP = 500
# The biggest JSON answer read whole to mirror it; anything larger streams through untouched.
_MIRROR_BYTES_CAP = 8 * 1024 * 1024


class Route(StrEnum):
    LOCAL = "local"  # the local handler answers
    PROXY = "proxy"  # the hub answers, verbatim
    UNAVAILABLE = "unavailable"  # only the hub could answer and it can't be reached (409)


@dataclass
class GraphPath:
    """A graph path read the way the hub reads it, without the desktop's action registry.

    The desktop parser drops a segment it does not know as an action (``conversation/<id>/pickup``
    parses as a bare op on the conversation) and refuses others (``invitation/pending``), so the
    routing decision cannot rest on it: a hub path the desktop never heard of must still go to
    the hub intact.
    """

    type: str | None
    id: str | None
    rest: list[str]  # the action segment, then its sub-path

    @property
    def action(self) -> str | None:
        return self.rest[0].lower() if self.rest else None


def parse_graph_path(path: str) -> GraphPath | None:
    """``/api/v1/graph/[<type>/<id>/...]<type>[/<id>][/<action>[/<sub...>]]`` → ``GraphPath``."""
    from flow_sdk.api.api_request import APIRequest  # noqa: PLC0415
    from flow_sdk.api.api_types.identifier import is_valid_identifier  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    prefix = f"{APIRequest.api_prefix}{APIRequest.graph_prefix}/"
    if not path.startswith(prefix):
        return None
    segs = [s for s in path[len(prefix) :].split("/")]
    while segs and segs[-1] == "":
        segs.pop()
    def is_type(seg: str) -> bool:
        # ``is_entity_type`` alone misses the ``_hub_only`` types (no local storage).
        return SchemaRegistry.is_entity_type(seg) or SchemaRegistry.get_entity_cls(seg) is not None

    entity_type: str | None = None
    entity_id: str | None = None
    i = 0
    # Leading (type, id) pairs: the last one is the target; a type after them is a scoped list.
    while i + 1 < len(segs) and is_type(segs[i].lower()) and is_valid_identifier(segs[i + 1]):
        entity_type, entity_id = segs[i].lower(), segs[i + 1]
        i += 2
    if entity_type is None and segs and is_type(segs[0].lower()):
        entity_type = segs[0].lower()
        i = 1
    return GraphPath(entity_type, entity_id, segs[i:])


def _online() -> bool:
    return is_logged_in() and not is_local_mode()


async def decide(
    method: str, path: str, hub_reflect: bool, target: Entity | None = None
) -> tuple[Route, GraphPath | None, Entity | None]:
    """Where a graph request is answered — the ONE rule, for HTTP and WS alike.

    - a ``_hub_only`` type: the hub, always (409 when it can't be reached);
    - entity files of a git-backed remote asset: the hub (git is their only authority);
    - otherwise only when the caller asked (``Hub-Reflect``) and this box is signed in:
      * an id: the hub, unless that row is here and is not remote (a local-only entity);
      * no id: the hub — list / create, a scoped child list, a type or root action. A desktop
        action of the same name does not shadow it: asking for the hub means the hub's.
    Entity files of a row held here are served here (uploads are written through to the hub by
    ``_reflect_fs_to_hub``); files of a row held only by the hub are the hub's.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    gp = parse_graph_path(path)
    if gp is None:
        return Route.LOCAL, None, None
    cls = SchemaRegistry.get_entity_cls(gp.type) if gp.type else None
    if cls is not None and cls._hub_only:
        return (Route.PROXY if _online() else Route.UNAVAILABLE), gp, None

    entity = None
    if cls is not None and gp.id:
        if target is not None and getattr(target, "id", None) == gp.id and getattr(target, "type", None) == gp.type:
            entity = target
        else:
            try:
                entity = await cls.get_by_id(gp.id)
            except Exception:  # noqa: BLE001 — an unreadable row is a missing row
                entity = None

    if gp.action == "fs" and is_git_backed_remote_fs(entity, "fs"):
        return Route.PROXY, gp, entity
    if not (hub_reflect and _online()):
        return Route.LOCAL, gp, entity
    if gp.action == "fs" and entity is not None:
        return Route.LOCAL, gp, entity  # this box holds the files (a cache filled from the hub on a miss)
    if _admits_locally(method, gp, entity):
        return Route.LOCAL, gp, entity
    if gp.id:
        if entity is not None and getattr(entity, "remote", False) is not True:
            return Route.LOCAL, gp, entity
        return Route.PROXY, gp, entity
    return Route.PROXY, gp, None


def _admits_locally(method: str, gp: GraphPath, entity: Entity | None) -> bool:
    """An invitation into a row held here (``POST <type>/<id>/members``, or its invite ``/link``).

    The same ``MembershipRequest`` the hub takes, answered here first so the desktop can publish
    a row the hub doesn't have yet and add a conversation's shared skills/agents before sending it
    on (``members_action.members``).
    """
    return method.upper() == "POST" and gp.rest in (["members"], ["members", "link"]) and entity is not None


def _is_bare_update(method: str, gp: GraphPath, entity: Entity | None) -> bool:
    return entity is not None and gp.id is not None and not gp.rest and method.upper() in ("PUT", "PATCH")


async def _update_body(request_body: bytes, entity: Entity) -> bytes | None:
    """The body a bare update sends: narrowed to what an assignee may change. ``None`` means
    nothing in it is the hub's to hold — the update stays local."""
    import json  # noqa: PLC0415

    try:
        body = json.loads(request_body or b"{}")
    except ValueError:
        return request_body
    if not isinstance(body, dict):
        return request_body
    if _changes_only_local_fields(entity, body):
        return None
    scoped = scope_body_to_assignee_fields(entity, body)
    return request_body if scoped is body else json.dumps(scoped).encode()


def _wants_mirror(status: int, content_type: str, length: int | None, gp: GraphPath, entity: Entity | None) -> bool:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    if not (200 <= status < 300) or "json" not in content_type:
        return False
    if length is not None and length > _MIRROR_BYTES_CAP:
        return False
    if entity is not None:
        return True  # ``mirror_answer`` folds only an answer that IS this row (or its roster)
    cls = SchemaRegistry.get_entity_cls(gp.type) if gp.type else None
    return cls is not None and not cls._hub_only and gp.action is None and gp.id is None


async def route_to_hub(request: Request, target: Entity | None = None) -> Response | None:
    """Answer an HTTP graph request from the hub when ``decide`` says so; ``None`` = run it locally.

    The hub's status, headers and body come back verbatim. A JSON answer about rows this box
    keeps is folded into them afterwards (``mirror_answer``); that never changes the answer.
    Nothing came back: a read falls back to the local copy, everything else fails loudly.
    """
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    hub_reflect = (request.headers.get("hub-reflect") or "").lower() in ("true", "1", "yes")
    route, gp, entity = await decide(request.method, request.url.path, hub_reflect, target)
    if route is Route.LOCAL:
        return None
    if route is Route.UNAVAILABLE:
        detail = _HUB_ONLY_OFFLINE.format(type=gp.type if gp else "This")
        return JSONResponse({"status": "FAIL", "message": detail, "data": None}, status_code=409)

    if gp.action == "fs" and entity is not None and request.method.upper() == "GET" and gp.rest[1:2] == ["document"]:
        # The desktop's document view of a git-backed asset, built from the hub's downloads.
        return await read_hub_document(request, entity, "/".join(gp.rest[2:]))
    content = None
    if _is_bare_update(request.method, gp, entity):
        content = await _update_body(await request.body(), entity)
        if content is None:
            return None
    try:
        resp = await HubProxy.open(request, content=content)
    except HubError as e:
        if e.status_code == 0 and request.method.upper() in ("GET", "HEAD") and gp.type is not None:
            logger.warning("[hub-proxy] %s %s: hub unreachable, answering from the local copy", request.method, gp)
            return None
        return HubProxy.failure(e)

    length = resp.headers.get("content-length")
    if not _wants_mirror(
        resp.status_code, resp.headers.get("content-type", ""), int(length) if length else None, gp, entity
    ):
        return HubProxy.relay(resp)
    try:
        raw = await resp.aread()
    finally:
        await resp.aclose()
    await mirror_answer(request.method, gp, entity, raw)
    headers = [(k, v) for (k, v) in HubProxy.inbound_headers(list(resp.headers.raw))
               if k.lower() not in (b"content-encoding", b"content-length")]  # fmt: skip
    out = Response(raw, status_code=resp.status_code)
    out.raw_headers = headers + [(b"content-length", str(len(raw)).encode())]
    return out


async def route_ws_to_hub(method: str, path: str, query: str, body: Any, hub_reflect: bool) -> tuple[int, Any] | None:
    """``route_to_hub`` for a WS ``rest_api_msg``: ``(status, parsed body)`` or ``None`` = local."""
    import json  # noqa: PLC0415

    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    route, gp, entity = await decide(method, path, hub_reflect)
    if route is Route.LOCAL:
        return None
    if route is Route.UNAVAILABLE:
        return 409, {
            "status": "FAIL",
            "message": _HUB_ONLY_OFFLINE.format(type=gp.type if gp else "This"),
            "data": None,
        }
    content = json.dumps(body).encode() if body not in (None, "") else None
    if _is_bare_update(method, gp, entity):
        content = await _update_body(content or b"{}", entity)
        if content is None:
            return None
    headers = [(b"content-type", b"application/json")] if content else []
    try:
        answer = await HubProxy.forward_buffered(method, path, query, headers=headers, content=content)
    except HubError as e:
        if e.status_code == 0 and method.upper() in ("GET", "HEAD") and gp.type is not None:
            return None
        failure = HubProxy.failure(e)
        return failure.status_code, json.loads(failure.body)
    if _wants_mirror(answer.status_code, answer.content_type, len(answer.content), gp, entity):
        await mirror_answer(method, gp, entity, answer.content)
    try:
        return answer.status_code, answer.json()
    except ValueError:
        return answer.status_code, answer.content.decode("utf-8", "replace")


async def mirror_answer(method: str, gp: GraphPath, entity: Entity | None, raw: bytes) -> None:
    """Fold a hub answer into the rows this box keeps — never changes the answer itself.

    - ``members`` on an entity: the roster cache (re-read after a change: a mutation answers a
      message, not the roster);
    - the entity itself — any answer that is this row (a read, an update, ``close``/``pickup``…);
    - a list of a type kept here: each row this box already holds as remote.

    Both through the one mirror (``Entity.mirror_from_hub``: the fields ``Sharing`` says the hub
    owns). An answer is the hub's whole row, so its ``null`` clears. Rows a list adds or drops
    are the sync's (``conversation-list``, the WS bridge), which sees the whole set.
    """
    import json  # noqa: PLC0415

    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    try:
        data = (json.loads(raw) or {}).get("data")
    except (ValueError, AttributeError):
        return
    try:
        if entity is not None and gp.action == "members":
            if len(gp.rest) > 1:
                return  # members/<sub> is another endpoint (a link), not the roster
            if method.upper() != "GET":
                from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

                data = await HubProxy.call("GET", entity.type, entity.id, "members")
            await mirror_hub_response_into_local(entity, "members", normalize_hub_response("members", data))
            return
        if entity is not None:
            if isinstance(data, dict) and data.get("id") == entity.id:
                await type(entity).mirror_from_hub(data, existing=entity, nulls_clear=True)
            return
        cls = SchemaRegistry.get_entity_cls(gp.type) if gp.type else None
        if cls is None or not isinstance(data, list):
            return
        for row in data[:_MIRROR_LIST_CAP]:
            if not isinstance(row, dict) or not row.get("id"):
                continue
            local = await cls.get_by_id(row["id"])
            if local is not None and getattr(local, "remote", False) is True:
                await cls.mirror_from_hub(row, existing=local, nulls_clear=True)
    except Exception as e:  # noqa: BLE001 — a mirror miss is a stale row, never a failed call
        logger.warning("[hub-proxy] mirror of %s failed: %s", gp, e)


async def read_hub_document(request: Request, entity: Entity, path: str) -> Response:
    """Adapt the desktop document view to Hub's existing authoritative downloads."""
    from pathlib import PurePosixPath

    from flow_sdk.assets.document import read_document_bytes
    from flow_sdk.assets.entity_document import read_entity_document_bytes
    from flow_sdk.assets.serialization import entity_body_path
    from flow_sdk.cloud_client.hub_proxy import HubProxy
    from flow_sdk.cloud_client.transport.hub_http import hub_graph_url
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    async def download(relative: str):
        response = await HubProxy.forward(request, hub_graph_url(entity.type, entity.id, "fs", f"download/{relative}"))
        if response.status_code != 200:
            return response, b""
        try:
            raw = b"".join([chunk async for chunk in response.body_iterator])
        finally:
            if response.background:
                await response.background()
        return response, raw

    response, raw = await download(path)
    if response.status_code != 200:
        return response
    info = SchemaRegistry.get(entity.type)
    body_path = path
    if info is not None and info.is_entity_document and PurePosixPath(path).name == info.shape.main:
        body = b""
        if info.body_file is not None:
            body_path = str(entity_body_path(PurePosixPath(path).parent, info.body_file))
            body_response, body = await download(body_path)
            if body_response.status_code == 404:
                if body_response.background:
                    await body_response.background()
            elif body_response.status_code != 200:
                return body_response
        document = read_entity_document_bytes(raw, body, info)
    else:
        document = read_document_bytes(raw)
    data = document.model_dump(mode="json")
    data["body_ref"] = {"path": body_path, "type_id": str(entity.typeid), "ref_type": "text", "read_only": True}
    return JSONResponse({"status": "OK", "data": data})


async def _reflect_fs_to_hub(et, hub_id: str, sub_path: str | None) -> Any:
    """Mirror an entity-VFS upload to the hub, then let the local write proceed.

    Files on a shared entity are hub-authoritative; this machine's storage is a
    cache. Only ``upload`` needs mirroring — reads are served locally and fill
    from the hub on a miss (``fs_actions.fetch_remote_entity_file``), so browse
    / download / delete pass straight through untouched.
    """
    if not (sub_path or "").lower().startswith("upload"):
        return REFLECT_CONTINUE_LOCAL

    from starlette.datastructures import UploadFile  # noqa: PLC0415

    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

    request_info = get_current_request_info()
    if request_info is None:
        return REFLECT_CONTINUE_LOCAL
    try:
        post_data = await request_info.get_post_data()
    except Exception:  # noqa: BLE001
        return REFLECT_CONTINUE_LOCAL

    files: list[UploadFile] = []
    if isinstance(post_data, dict):
        for value in post_data.values():
            if isinstance(value, UploadFile):
                files.append(value)
            elif isinstance(value, list):
                files.extend(v for v in value if isinstance(v, UploadFile))

    for f in files:
        if not f.filename:
            continue
        content = await f.read()
        # The local handler reads these same objects afterwards — rewind, or it
        # writes an empty file into the cache.
        await f.seek(0)
        await HubProxy.upload(
            et, hub_id, "fs", sub_path, files={"uploaded_file": (f.filename, content, "application/octet-stream")}
        )
    return REFLECT_CONTINUE_LOCAL


def _changes_only_local_fields(entity: Entity, body: dict[str, Any]) -> bool:
    """True when a bare update changes something, and none of it is the hub's to be told: every
    changed field is declared ``PRIVATE`` (never leaves this machine) or ``HUB_READ`` (the hub's
    own clocks, which a client's whole-entity save echoes back in another spelling)."""
    not_for_hub = type(entity).fields_not_sent_to_hub()
    if not (body.keys() & not_for_hub):
        return False
    # A dump leaves out the fields that are unset, so a field is read with ``get``: unset is None.
    fields = type(entity).model_fields
    current = entity.model_dump(mode="json", include=set(body))
    changed = {name for name, value in body.items() if name in fields and current.get(name) != value}
    return bool(changed) and changed <= not_for_hub


def normalize_hub_response(action_name: str, hub_resp: Any) -> Any:
    """Translate hub field names into the canonical client shape.

    The hub's ``Membership`` response uses ``user_email`` / ``user_name`` /
    ``user_picture``; the client and the ``Entity.members`` roster cache
    expect ``email`` / ``name`` / ``picture``. Normalizing here means
    callers (TS SDK, local mirror, downstream UI) all see one shape.

    Unknown keys (``invitation_id``, ``invitation_method``, anything the
    hub adds later) pass through unchanged so future consumers don't need
    a coordinated dispatcher update.
    """
    if action_name != "members" or not isinstance(hub_resp, list):
        return hub_resp

    _HUB_TO_CLIENT = {
        "user_email": "email",
        "user_name": "name",
        "user_picture": "picture",
    }

    out: list[dict] = []
    for entry in hub_resp:
        if not isinstance(entry, dict):
            out.append(entry)
            continue
        # Pass through every non-renamed key verbatim (preserves invitation_id,
        # invitation_method, status, role, and any hub-added field).
        normalized: dict = {k: v for k, v in entry.items() if k not in _HUB_TO_CLIENT}
        # Then fill the client-form names from the legacy hub keys, but don't
        # overwrite a client-form key the entry already had (e.g. if a future
        # hub starts emitting both forms during a migration, the client form
        # wins).
        for hub_key, client_key in _HUB_TO_CLIENT.items():
            if hub_key in entry and client_key not in normalized:
                normalized[client_key] = entry[hub_key]
        out.append(normalized)
    return out


_MISSING = object()


async def mirror_hub_response_into_local(entity: Entity, action_name: str, hub_resp: Any) -> None:
    """Write hub-provided state back into the local entity row.

    Opportunistic: only writes fields the entity already exposes. Generic
    across entity types — no per-type custom logic. Specific actions can
    extend this later if they need richer merge semantics.
    """
    if hub_resp is None:
        return

    # Generic shape: the ``members`` action returns the roster list → mirror it
    # onto ``entity.members`` (the roster cache, now on the Entity base so this
    # fires for every remote type — org/team included, not just conversation/
    # project which previously declared their own field).
    if action_name == "members" and isinstance(hub_resp, list):
        if hasattr(entity, "members"):
            try:
                new_participants = list(hub_resp)
                # EQUALITY GUARD — only assign+save when the roster actually
                # changed. ``Entity.__setattr__`` marks the row dirty on *any*
                # assignment (it tracks assignment, not value), and ``save()``
                # fans an entity UPDATE. A reflect that re-mirrors the SAME
                # roster would therefore dirty → save → UPDATE → re-arm the
                # next members fetch → reflect again: an unbounded
                # fetch↔mirror↔refetch loop hammering the hub ~14×/s. Comparing
                # against the currently-stored value makes the mirror idempotent:
                # an unchanged roster is a no-op (no assignment, no save, no
                # UPDATE), so the loop converges after the first mirror. Compare
                # the already-normalized stored value against the new normalized
                # value (both went through ``normalize_hub_response``), so the
                # check isn't defeated by raw-vs-normalized key differences.
                current = list(getattr(entity, "members", None) or [])
                if current == new_participants:
                    return
                entity.members = new_participants
                # Best-effort save; never blow up the action if persistence fails.
                save = getattr(entity, "save", None)
                if callable(save):
                    await save()
            except Exception as e:  # noqa: BLE001
                logger.debug("[hub-reflect] mirror save failed for %s: %s", entity.type, e)
                return
            # A changed roster is also what the address book learns from: the
            # conversation sync skips a roster it finds already stored, so a
            # member email that arrived here would otherwise never reach the
            # contact. Same equality gate — an unchanged roster learns nothing.
            try:
                from flow_sdk.app.actions.flow_message_action import _learn_address_book  # noqa: PLC0415

                await _learn_address_book(new_participants)
            except Exception as e:  # noqa: BLE001
                logger.debug("[hub-reflect] contact learn failed for %s: %s", entity.type, e)

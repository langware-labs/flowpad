"""Display addresses as URLs — the read-only counterpart of `flow navigate`.

``navigate.py`` steers a browser tab and fails when none is open; the ``show``
action needs a process scope and emits an event. Neither answers the plain
question "what is the link to this record", which is what an agent needs when
it wants to hand a human something clickable (``flow record url``).

Two properties this route exists to guarantee:

* **The SERVER builds the URL, not the caller.** The UI is served by Vite on a
  different port than the API in every dev instance, so a CLI that built the
  link from its own discovered (API) port would emit a 404 there. The port
  rule has one owner — ``InstanceSettings.ui_port``.
* **It is side-effect free.** ``resolve_display_target`` can recover an
  unindexed path by parsing it and ``sync_to_db``-ing it — a mini index. That
  is opt-in (``discover=True``, which the display verbs pass and this route
  does not), so an unindexed path comes back as VFS and the caller is told to
  index it first.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter()


class DisplayUrlRequest(BaseModel):
    """Exactly one address. ``typeid`` wins when both are given."""

    typeid: Optional[str] = None
    path: Optional[str] = None


def _fail(error_code: str, message: str) -> ApiFailResponse:
    """A failure the CLI can branch on.

    Keyed on ``error_code`` rather than the HTTP status on purpose:
    ``ApiFailResponse.status_code`` is a BODY field, so a bare return from a
    handler still serialises as HTTP 200. A caller mapping exit codes off the
    transport status would collapse every one of these into a single code.
    """
    return ApiFailResponse(message=message, data={"error_code": error_code})


@router.post("/api/v1/display/url")
async def display_url(req: DisplayUrlRequest):
    """Resolve an address to its canonical asset-editor deep link.

    Body: ``{"typeid"?: str, "path"?: str}``.
    Data: ``{kind, typeid, type, name, path, editor, url}``.
    """
    from flow_sdk.core.asset_editor import editor_for_type  # noqa: PLC0415
    from flow_sdk.core.display_target import (  # noqa: PLC0415
        DisplayTargetKind,
        DisplayTargetNotFound,
        InvalidDisplayTarget,
        dock_url,
        resolve_display_target,
    )
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    typeid = (req.typeid or "").strip() or None
    path = (req.path or "").strip() or None
    if not typeid and not path:
        return _fail("INVALID_ARG", "Must include one of: typeid, path")

    try:
        target = await resolve_display_target(typeid=typeid, path=path)
    except InvalidDisplayTarget as e:
        return _fail("INVALID_ARG", str(e))
    except DisplayTargetNotFound as e:
        return _fail("NOT_FOUND", str(e))

    kind = target.get("kind")
    if kind == DisplayTargetKind.VFS:
        return _fail(
            "NOT_INDEXED",
            f"{target.get('path')} is not an indexed asset — run `flow record index <path>` first.",
        )

    type_name = str(target.get("type") or "")
    url = dock_url(target, port=get_instance_settings().ui_port)
    if url is None:
        # A shell, a project, a conversation. Not a document, so it has no
        # asset-editor link — say so rather than invent a URL segment. (A shell
        # does have a dock URL, but under a different grammar owned elsewhere.)
        return _fail(
            "NO_ASSET_EDITOR",
            f"'{type_name}' has no asset editor — there is no editor deep link for {target.get('typeid')}.",
        )

    return ApiSuccessResponse(
        data={
            "kind": str(kind),
            "typeid": target.get("typeid"),
            "type": type_name,
            "name": target.get("name"),
            "path": target.get("path"),
            "editor": str(editor_for_type(type_name) or ""),
            "url": url,
        }
    )

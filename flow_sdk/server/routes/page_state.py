"""``/api/v1/page-state`` — mint a page's state key, and read back what the key you hold stands for.

Minting is for machine callers only (``flow show``, agents through the CLI): an agent that opens a page
may give it a key of its own, to hand it a context. The app and every page it shows run with the app's
key, which mints nothing — so a page cannot hand itself, or another page, more reach.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.page_state_spec import PageState
from flow_sdk.server import page_state

router = APIRouter()


def _may_mint(request: Request) -> bool:
    return not page_state.enforced() or cookie_gate.verify_machine(request)


@router.post("/api/v1/page-state")
async def mint_page_state(request: Request, body: PageState):
    if not _may_mint(request):
        raise HTTPException(status_code=403, detail="Only Flowpad on this computer may open a page with a key of its own.")
    return ApiSuccessResponse(data={"key": page_state.mint(body.model_copy(update={"grant": "page"}))})


@router.get("/api/v1/page-state")
async def read_page_state(request: Request, probe: str | None = None):
    """What the key you hold stands for (``state``) and, when asked, what ANOTHER key stands for (``probed``).

    The app asks about the key a tab was opened with before it mounts the page, and an unknown key must not
    answer 403 — that would make the app's own window report a refusal it never suffered.
    """
    held, probed = page_state.state_of(request), page_state.lookup(probe)
    return ApiSuccessResponse(
        data={
            "enforced": page_state.enforced(),
            "state": held.model_dump(mode="json") if held else None,
            "probed": probed.model_dump(mode="json") if probed else None,
        }
    )

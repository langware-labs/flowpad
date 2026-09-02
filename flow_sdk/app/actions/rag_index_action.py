"""The REST surface of a ``RagIndex``: choose folders, run a pass, ask a question.

Five verbs and no more. Coverage is edited (``add-root`` / ``remove-root``, or
``toggle-root`` for a caller that knows only a folder and not which index owns it), a pass is
asked for (``index``), and the index is questioned (``query``). Everything a card needs to render —
status, counts, the last error, the roots themselves — is already on the entity, so there is no
status action: a GET of the row IS the status.

``index`` returns as soon as the pass is scheduled rather than awaiting it. Embedding a folder
is a paid, network-bound, minutes-long job, and an HTTP request that waits for it times out on
the first real corpus. The row carries the outcome, and the pass broadcasts when it lands.
"""

from __future__ import annotations

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiSuccessResponse


async def _index():
    """The addressed ``RagIndex``, or a 404."""
    from flow_sdk.builtin.rag_index import RagIndex

    info = get_current_request_info()
    target = getattr(getattr(info, "auth_result", None), "target", None)
    if target is not None:
        return target
    entity = await RagIndex.get_by_typeid(info.target_entity_typeid) if info else None
    if entity is None:
        raise HTTPException(status_code=404, detail="rag_index not found")
    return entity


async def _body() -> dict:
    info = get_current_request_info()
    data = await info.get_post_data() if info else None
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="a JSON body is required")
    return data


@action.post(action_name="add-root", types=["rag_index"])
async def add_root_action():
    index = await _index()
    return await index.add_root(str((await _body()).get("path") or ""))


@action.post(action_name="remove-root", types=["rag_index"])
async def remove_root_action():
    index = await _index()
    return await index.remove_root(str((await _body()).get("path") or ""))


@action.post(action_name="index", types=["rag_index"])
async def index_action():
    """Schedule a pass. ``force`` re-reads every document; it still re-embeds nothing unchanged.

    The refusal, when there is one, is the sentence — the caller shows it rather than decoding
    a status code.
    """
    from flow_sdk.rag import reconcile

    index = await _index()
    # A person asking to index is the moment to look for funding again.
    refusal = await index.settle_status()
    if refusal:
        return ApiSuccessResponse(data={"scheduled": False, "refusal": refusal})

    body = {}
    info = get_current_request_info()
    if info:
        try:
            raw = await info.get_post_data()
            body = raw if isinstance(raw, dict) else {}
        except Exception:  # noqa: BLE001 — an empty body is the common case, and it is fine
            body = {}

    if bool(body.get("force")):
        # A forced pass bypasses the pending flag, so ask for it directly rather than waiting
        # for the heartbeat to notice a mark that force does not set.
        reconcile.force_pass(index)
    else:
        index.pending = True
        await index.save(notify=False)
        await reconcile.dispatch_due_indexes()
    return ApiSuccessResponse(data={"scheduled": True, "refusal": ""})


@action.post(action_name="rag-toggle-root", types=None)
async def toggle_root_action():
    """Make a folder searchable, or stop. Addressed by PATH, not by index.

    Entity-less on purpose: the caller is a folder row in the tree, which knows a path and has
    no reason to know which index owns it — or to pick one before it can answer "should this be
    searchable". The box's single index is found or created here. When there is a reason to run
    several, this is where the choice belongs.
    """
    from flow_sdk.builtin.rag_index import RagIndex

    path = str((await _body()).get("path") or "")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")

    index, covered = await RagIndex.toggle_root(path)
    return ApiSuccessResponse(
        data={"covered": covered, "index_id": str(index.id), "roots": index.roots}
    )


@action.post(action_name="query", types=["rag_index"])
async def query_action():
    """Ask the index a question. Embeds the query with the SAME model the chunks were embedded
    with — a vector from a different model is meaningless in this space, not merely worse.
    """
    from flow_sdk.rag import reconcile

    index = await _index()
    body = await _body()
    question = str(body.get("q") or body.get("query") or "")
    if not question:
        raise HTTPException(status_code=400, detail="q is required")
    top_k = int(body.get("top_k") or 8)

    embed, _model = await reconcile.embedder_for(index)
    if embed is None:
        return ApiSuccessResponse(
            data={"hits": [], "refusal": "no embedding endpoint is available on this machine"}
        )
    vectors = await embed([question])
    async with index.open_store() as store:
        hits = store.search(vectors[0], top_k=top_k)
    return ApiSuccessResponse(
        data={
            "refusal": "",
            "hits": [
                {
                    "doc_ref": h.doc_ref,
                    "heading_path": h.heading_path,
                    "text": h.text,
                    "score": h.score,
                }
                for h in hits
            ],
        }
    )

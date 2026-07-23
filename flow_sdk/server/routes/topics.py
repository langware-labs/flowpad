"""Topic context — the derived join behind ``flow topic <name> get``.

Assembles everything bound to a dot-taxonomy topic at query time (nothing is
ever stored on the Topic entity — see flow_sdk/builtin/topic.py):

* **header** — the blessed Topic entity (or anonymous) + blessed ancestors.
* **docs**  — markdown entities whose frontmatter ``topics:`` list contains the
  topic or a descendant. Modes: ``line`` (one-line summary each) / ``block``
  (≤60-word summary each) / ``full`` (bodies, size-capped). Summaries resolve
  LLM-free via ``flow_sdk.llm_index.sizes`` (cache → frontmatter → title+para).
* **code**  — source files carrying a ``topic`` capsule (line-comment carrier)
  under the request's ``root``, with their per-topic one-liners.
* **mentions** — wiki backlinks (``[[topic.name]]``) when the topic is blessed.

Anonymous topics degrade gracefully: no header entity, docs/code still work.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter()

_MODES = ("line", "block", "full")


async def _bound_docs(name: str) -> list[dict[str, Any]]:
    """Markdown entities whose ``topics`` list contains ``name`` or a
    descendant (shared reader — see flow_sdk/topics/bindings.py)."""
    from flow_sdk.topics.bindings import all_doc_bindings  # noqa: PLC0415

    return await all_doc_bindings(name)


def _doc_body(doc: dict[str, Any]) -> str:
    ref = doc.get("asset_ref") or ""
    if ref:
        try:
            return Path(ref).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            pass
    return doc.get("body") or ""


def _scan_code_capsules(root: Path, name: str) -> list[dict[str, Any]]:
    """Source files under ``root`` carrying a ``topic`` capsule naming this
    topic or a descendant (shared reader — see flow_sdk/topics/bindings.py)."""
    from flow_sdk.topics.bindings import scan_code_capsules  # noqa: PLC0415

    return scan_code_capsules(root, name)


async def _header(name: str) -> dict[str, Any]:
    from flow_sdk.builtin.topic import resolve_topic  # noqa: PLC0415
    from flow_sdk.topics.grammar import topic_ancestors  # noqa: PLC0415

    blessed = await resolve_topic(name)
    ancestors: list[dict[str, Any]] = []
    for ancestor in topic_ancestors(name):
        entity = await resolve_topic(ancestor)
        if entity is not None:
            ancestors.append({
                "name": entity.name,
                "title": entity.title,
                "description": entity.description,
            })
    header: dict[str, Any] = {"name": name, "blessed": blessed is not None, "ancestors": ancestors}
    if blessed is not None:
        header.update({
            "id": blessed.id,
            "title": blessed.title,
            "description": blessed.description,
            "system": blessed.system,
            "deprecated": blessed.deprecated,
        })
    return header


async def _mentions(header: dict[str, Any]) -> list[dict[str, Any]]:
    if not header.get("blessed"):
        return []
    from flow_sdk.wiki.indexer import backlinks  # noqa: PLC0415

    try:
        links = await backlinks("topic", header["id"])
    except Exception:  # noqa: BLE001 — mentions are best-effort garnish
        return []
    return [
        {"src_type": link.src_type, "src_id": link.src_id, "line": link.line}
        for link in links
    ]


@router.post("/api/v1/topics/context")
async def topic_context(request: Request):
    """The join. Body: ``{name, mode?: line|block|full, root?: path}``."""
    from flow_sdk.llm_index.sizes import FULL_MAX_BYTES, resolve_doc_summaries  # noqa: PLC0415
    from flow_sdk.topics.grammar import normalize_topic  # noqa: PLC0415

    try:
        body = await request.json()
    except Exception:
        body = {}
    raw_name = str((body or {}).get("name") or "")
    mode = str((body or {}).get("mode") or "line")
    root_arg: Optional[str] = (body or {}).get("root")
    if mode not in _MODES:
        return ApiFailResponse(message=f"mode must be one of {', '.join(_MODES)}")
    try:
        name = normalize_topic(raw_name)
    except (TypeError, ValueError) as exc:
        return ApiFailResponse(message=f"invalid topic name: {exc}")

    header = await _header(name)

    docs_out: list[dict[str, Any]] = []
    budget = FULL_MAX_BYTES
    for doc in await _bound_docs(name):
        doc_body = _doc_body(doc)
        line, block = resolve_doc_summaries(doc.get("asset_ref") or doc["title"], doc_body)
        item: dict[str, Any] = {
            "id": doc["id"],
            "title": doc["title"],
            "asset_ref": doc["asset_ref"],
            "topics": doc["topics"],
            "line": line,
        }
        if mode in ("block", "full"):
            item["block"] = block
        if mode == "full":
            trimmed = doc_body[:budget]
            item["body"] = trimmed
            item["truncated"] = len(trimmed) < len(doc_body)
            budget = max(0, budget - len(trimmed))
        docs_out.append(item)

    code_out: list[dict[str, Any]] = []
    if root_arg:
        root = Path(root_arg).expanduser()
        if root.is_dir():
            code_out = _scan_code_capsules(root, name)

    return ApiSuccessResponse(data={
        "topic": header,
        "mode": mode,
        "docs": docs_out,
        "code": code_out,
        "mentions": await _mentions(header),
    })

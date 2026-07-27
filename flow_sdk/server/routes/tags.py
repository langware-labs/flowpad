"""Tag context — the derived join behind ``flow tag <name> get``.

Assembles everything bound to a dot-taxonomy tag at query time (nothing is
ever stored on the Tag entity — see flow_sdk/builtin/tag.py):

* **header** — the blessed Tag entity (or anonymous) + blessed ancestors.
* **docs**  — markdown entities whose frontmatter ``tags:`` list contains the
  tag or a descendant. Modes: ``line`` (one-line summary each) / ``block``
  (≤60-word summary each) / ``full`` (bodies, size-capped). Summaries resolve
  LLM-free via ``flow_sdk.llm_index.sizes`` (cache → frontmatter → title+para).
* **code**  — source files carrying a ``tag`` capsule (line-comment carrier)
  under the request's ``root``, with their per-tag one-liners.
* **mentions** — wiki backlinks (``[[tag.name]]``) when the tag is blessed.

Anonymous tags degrade gracefully: no header entity, docs/code still work.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter()

_MODES = ("line", "block", "full")


def _doc_body(doc: dict[str, Any]) -> str:
    ref = doc.get("asset_ref") or ""
    if ref:
        try:
            return Path(ref).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            pass
    return doc.get("body") or ""


async def _header(name: str) -> dict[str, Any]:
    from flow_sdk.builtin.tag import resolve_tag  # noqa: PLC0415
    from flow_sdk.tags.grammar import tag_ancestors  # noqa: PLC0415

    blessed = await resolve_tag(name)
    ancestors: list[dict[str, Any]] = []
    for ancestor in tag_ancestors(name):
        entity = await resolve_tag(ancestor)
        if entity is not None:
            ancestors.append(
                {
                    "name": entity.name,
                    "title": entity.title,
                    "description": entity.description,
                }
            )
    header: dict[str, Any] = {"name": name, "blessed": blessed is not None, "ancestors": ancestors}
    if blessed is not None:
        header.update(
            {
                "id": blessed.id,
                "title": blessed.title,
                "description": blessed.description,
                "system": blessed.system,
                "deprecated": blessed.deprecated,
            }
        )
    return header


async def _mentions(header: dict[str, Any]) -> list[dict[str, Any]]:
    if not header.get("blessed"):
        return []
    from flow_sdk.tags.bindings import tag_mentions  # noqa: PLC0415

    links = await tag_mentions(header["id"])
    return [{"src_type": link.src_type, "src_id": link.src_id, "line": link.line} for link in links]


@router.post("/api/v1/tags/context")
async def tag_context(request: Request):
    """The join. Body: ``{name, mode?: line|block|full, root?: path}``."""
    from flow_sdk.llm_index.sizes import FULL_MAX_BYTES, resolve_doc_summaries  # noqa: PLC0415
    from flow_sdk.tags.bindings import all_doc_bindings, scan_code_capsules  # noqa: PLC0415
    from flow_sdk.tags.grammar import normalize_tag  # noqa: PLC0415

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
        name = normalize_tag(raw_name)
    except (TypeError, ValueError) as exc:
        return ApiFailResponse(message=f"invalid tag name: {exc}")

    header = await _header(name)

    docs_out: list[dict[str, Any]] = []
    budget = FULL_MAX_BYTES
    for doc in await all_doc_bindings(name):
        doc_body = _doc_body(doc)
        line, block = resolve_doc_summaries(doc.get("asset_ref") or doc["title"], doc_body)
        item: dict[str, Any] = {
            "id": doc["id"],
            "title": doc["title"],
            "asset_ref": doc["asset_ref"],
            "tags": doc["tags"],
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
            code_out = scan_code_capsules(root, name)

    return ApiSuccessResponse(
        data={
            "tag": header,
            "mode": mode,
            "docs": docs_out,
            "code": code_out,
            "mentions": await _mentions(header),
        }
    )

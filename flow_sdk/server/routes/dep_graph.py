"""Dep graph routes — POST builds the index; GET reads it (no implicit rebuild)."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter

from flow_sdk.dep_graph import build_dep_graph, load_graph

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/v1/dep_graph/build")
async def build():
    result = await asyncio.to_thread(build_dep_graph)
    return {
        "ok": True,
        "counts": {"nodes": len(result.nodes), "edges": len(result.edges)},
        "duration_ms": result.duration_ms,
    }


@router.get("/api/v1/dep_graph")
async def get_graph():
    return await asyncio.to_thread(lambda: load_graph().to_dict())

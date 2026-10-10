"""Call the local graph API in-process: real request middleware + graph dispatcher, no server."""

from __future__ import annotations


async def call_local(method: str, path: str, json: dict | None = None, params: dict | None = None):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    import flow_sdk.app.actions  # noqa: F401 — side-effect registration
    from flow_sdk.server.middleware.request_transaction_middleware import RequestTransactionMiddleware
    from flow_sdk.server.routes import graph_router

    app = FastAPI()
    app.add_middleware(RequestTransactionMiddleware)
    app.include_router(graph_router, prefix="/api/v1/graph")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as client:
        return await client.request(method, f"/api/v1/graph/{path}", json=json, params=params)

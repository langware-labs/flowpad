"""Shared scaffolding for the ingestion tests — the SDK's source test helpers, plus the shared feed
fixtures the engine's end-to-end tests serve."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.ingest.testing import Responder, local_http_server, make_data_source, position

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "ingest"


def with_token(monkeypatch, driver_class, token: str = "tok"):
    """*driver_class*, with `_token` answering *token*."""
    async def _answer(self, source):
        return token

    monkeypatch.setattr(driver_class, "_token", _answer)
    return driver_class()


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def serve_fixture(name: str, *, headers: dict | None = None) -> Responder:
    """A responder that returns one fixture file for any path."""
    body = fixture_bytes(name)

    def respond(_path, _req_headers):
        return 200, body, dict(headers or {"Content-Type": "application/xml"})

    return respond


__all__ = ["FIXTURES", "fixture_bytes", "local_http_server", "make_data_source", "position", "serve_fixture", "with_token"]

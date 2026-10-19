"""One fake for the SDK's connections: the backend list ``get_connections`` reads, and the token a row hands out."""

from __future__ import annotations

from typing import Mapping, Sequence, Union

from flow_sdk.schema.data_spec.connection_spec import ConnectionSpec

Rows = Union[Sequence[ConnectionSpec], Mapping[str, ConnectionSpec]]


def fake_connections(monkeypatch, rows: Rows) -> None:
    """Serve ``rows`` as ``compute_node/@local/connections`` would, and their tokens.

    ``rows`` is read on every call, so a mapping the test mutates (a connect that
    grants) is seen by the next lookup. Without ``include_unconnected`` only the
    held rows come back — the screen's table — so a caller that forgets the flag
    loses its unconnected providers here exactly as it would against the backend.

    ``Connection.token()`` on a connected row answers ``token-for-<provider>``; an
    unconnected one is NOT_CONNECTED. A test that needs other tokens patches
    ``token_for_spec`` after calling this.
    """
    from flow_sdk import connections  # noqa: PLC0415
    from flow_sdk.schema.data_spec.connection_spec import (  # noqa: PLC0415
        ConnectionTokenResult,
        ConnectionTokenStatus,
    )

    async def list_connections(project_id: str = "", *, include_unconnected: bool = False):
        current = list(rows.values()) if isinstance(rows, Mapping) else list(rows)
        return [row for row in current if include_unconnected or row.connected]

    async def token_for_spec(spec: ConnectionSpec) -> ConnectionTokenResult:
        if not spec.connected:
            return ConnectionTokenResult(status=ConnectionTokenStatus.NOT_CONNECTED)
        return ConnectionTokenResult(status=ConnectionTokenStatus.AVAILABLE, token=f"token-for-{spec.provider}")

    monkeypatch.setattr(connections, "list_connections", list_connections)
    monkeypatch.setattr(connections, "token_for_spec", token_for_spec)

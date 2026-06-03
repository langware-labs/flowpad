"""BrowserContextWatch — mirror per-connection browser context to hub watches.

When a UI connection's ``browser_context`` includes a ``remote`` entity, this
subsystem registers a **hub** watch for it (the hub's ``watch`` action, which
links the entity to our ``Connection`` via ``ConnectedThrough``), keyed by THIS
backend's session-stable hub WS connection id. The hub then fans that entity's
UPDATE ``data_op`` frames back to our bridge → ``_handle_conversation_op`` →
local broadcast → the watching UI — i.e. cross-user live updates. The watch is
removed when the entity leaves every connection's context, or on disconnect.

This is a separate, cloud-facing subsystem: it does NOT touch the local watch
registry (``flow_sdk/app/actions/watch_registry.py``), which serves the
orthogonal UI-connection↔local-backend broadcast routing.

It is the translator between *many local UI connections* (each carrying its own
``browser_context``) and the *single backend hub connection* that holds the
watches — so a remote entity in N tabs is one hub watch (refcounted), torn down
when the last tab drops it.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class BrowserContextWatch:
    def __init__(self) -> None:
        # local UI connection_id -> set of remote entity keys ("type:id") it holds
        self._per_conn: dict[str, set[str]] = {}
        # entity key ("type:id") -> number of local connections currently holding it
        self._refcount: dict[str, int] = {}

    async def on_context(self, connection_id: str, context: dict) -> None:
        """Reconcile one connection's context snapshot against its prior set.

        Newly-present remote entities are watched (on the 0→1 refcount edge);
        newly-absent ones are unwatched (on the 1→0 edge). Wholesale snapshot in,
        diff out — matches how the backend stores ``info.browser_context``.
        """
        new_keys = await self._remote_keys(context)
        old_keys = self._per_conn.get(connection_id, set())
        if new_keys == old_keys:
            return
        for key in new_keys - old_keys:
            if self._incr(key):
                await self._hub_call(key, "watch")
        for key in old_keys - new_keys:
            if self._decr(key):
                await self._hub_call(key, "unwatch")
        if new_keys:
            self._per_conn[connection_id] = new_keys
        else:
            self._per_conn.pop(connection_id, None)

    async def on_disconnect(self, connection_id: str) -> None:
        """A connection dropped — equivalent to it reporting an empty context:
        release every entity it held and unwatch the ones no other connection
        still holds. Reuses ``on_context``'s diff/refcount path."""
        await self.on_context(connection_id, {})

    async def resync(self) -> None:
        """Re-register all active watches against the (re)connected bridge.

        Called after the hub WS connects/verifies. Idempotent on the hub
        (``save_relationship`` of an existing ``ConnectedThrough`` is a no-op),
        and it re-establishes watches that were skipped while the bridge was
        down or that the hub GC'd along with a prior ``Connection``.
        """
        # Every key in _refcount is held by >=1 connection (_decr drops it at 0).
        for key in list(self._refcount):
            await self._hub_call(key, "watch")

    # ── refcount ────────────────────────────────────────────────────────────

    def _incr(self, key: str) -> bool:
        """Increment refcount; return True on the first watcher (0→1)."""
        n = self._refcount.get(key, 0)
        self._refcount[key] = n + 1
        return n == 0

    def _decr(self, key: str) -> bool:
        """Decrement refcount; return True when it drops to 0 (caller unwatches)."""
        n = self._refcount.get(key, 0)
        if n <= 1:
            self._refcount.pop(key, None)
            return n == 1
        self._refcount[key] = n - 1
        return False

    # ── classification ──────────────────────────────────────────────────────

    async def _remote_keys(self, context: dict) -> set[str]:
        """The set of ``remote``, hub-watchable entity keys in this snapshot.

        Gated: must be cloud-logged-in; each context value must parse to a
        locally-known entity whose ``remote`` is True and whose type has a hub
        counterpart (``_entity_type_enum`` not None). Non-qualifying slots
        (null, local-only, plugin types, unknown ids) are silently dropped.
        """
        from flow_sdk.cli.auth.hub_login import is_logged_in

        if not isinstance(context, dict) or not is_logged_in():
            return set()

        from flow_sdk.cloud_client.hub_bridge import _parse_to_entity
        from flow_sdk.core.entity.entity_model import Entity
        from flow_sdk.server.routes._hub_reflect import _entity_type_enum

        keys: set[str] = set()
        seen: set[tuple[str, str]] = set()
        for value in context.values():
            if not value or not isinstance(value, str):
                continue
            etype, eid = _parse_to_entity(value)
            if not etype or not eid or (etype, eid) in seen:
                continue
            seen.add((etype, eid))
            try:
                model = Entity.get_entity_model_by_type(etype)
                if model is None:
                    continue
                entity = await model.get_by_id(eid)
            except Exception:  # noqa: BLE001 — a bad context value must never break the handler
                continue
            if entity is None or getattr(entity, "remote", False) is not True:
                continue
            if _entity_type_enum(entity) is None:
                continue
            keys.add(f"{etype}:{eid}")
        return keys

    # ── hub I/O ─────────────────────────────────────────────────────────────

    async def _hub_call(self, key: str, action: str) -> None:
        """POST the hub ``watch``/``unwatch`` action for ``key`` using our conn id.

        No-op (deferred to ``resync``) when the bridge isn't connected. Never
        raises — a hub failure must not break the WS handler that called us.
        """
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        cid = hub_ws_manager.connection_id
        if not cid or not hub_ws_manager.is_connected:
            return
        etype, _, eid = key.partition(":")
        try:
            from flow_sdk.cloud_client.transport.hub_http import hub_post
            from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

            et = BuiltinEntityType(etype)
        except Exception:  # noqa: BLE001 — unknown type → nothing to watch
            return
        try:
            await hub_post(et, {"connection_id": cid}, eid, action=action)
            logger.debug("[browser-context-watch] hub %s %s via conn %s", action, key, cid)
        except Exception as e:  # noqa: BLE001
            logger.debug("[browser-context-watch] hub %s failed for %s: %s", action, key, e)


# Process-wide singleton (one per backend, like ``hub_ws_manager``).
browser_context_watch = BrowserContextWatch()

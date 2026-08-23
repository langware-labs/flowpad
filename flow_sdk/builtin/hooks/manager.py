"""``HooksManager`` — one interface for every hook scope and harness.

Two implementations: ``GlobalHooksManager`` (User / Project / LocalProject — a
file the harness discovers on its own) and ``ProcessHooksManager`` (Process —
argv the launcher hands over). Callers configure hooks, set callbacks and read
events the same way through either; what differs is only where the hook lands
and which cells the harness supports.

Unsupported ``(harness, scope, event)`` combinations raise ``NotImplementedError``
from ``configure`` — never at delivery, so a hook that could never fire cannot be
installed in the first place.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional

from flow_sdk.builtin.hooks import callbacks as _callbacks
from flow_sdk.builtin.hooks.callbacks import AgentHookCallback, Unsubscribe
from flow_sdk.builtin.hooks.types import (
    AgentHookResponse,
    HookCapabilities,
    HookCapability,
    HookEventType,
    HookInfo,
    HookScope,
)
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData


class HooksManager(ABC):
    """Configure hooks, subscribe to them, and deliver them — scope-agnostically."""

    #: Driver name ("claude" / "codex" / "copilot").
    provider: str
    #: Scope used when a caller doesn't name one.
    default_scope: HookScope

    # ── capability ───────────────────────────────────────────────────────────

    @abstractmethod
    def capabilities(self) -> HookCapabilities:
        """This manager's declared scopes, from the driver."""

    def supported_scopes(self) -> frozenset[HookScope]:
        """Scopes that can actually carry a hook.

        A scope declared with NO events is still unsupported — the declaration
        exists only to carry the reason into the error. "Declared" and
        "supported" are different questions and conflating them would let a
        caller install a hook that can never fire.
        """
        return frozenset(scope for scope, cap in self.capabilities().items() if cap.events)

    def supported_events(self, scope: Optional[HookScope] = None) -> frozenset[HookEventType]:
        cap = self.capabilities().get(scope or self.default_scope)
        return cap.events if cap else frozenset()

    def supports_response(self, event: HookEventType, scope: Optional[HookScope] = None) -> bool:
        cap = self.capabilities().get(scope or self.default_scope)
        return bool(cap and cap.supports_response(event))

    def require(self, event: HookEventType, scope: Optional[HookScope] = None) -> HookCapability:
        """The single gate. Raises ``NotImplementedError`` for an unsupported cell."""
        scope = scope or self.default_scope
        cap = self.capabilities().get(scope)
        if cap is None or not cap.events:
            reason = f" — {cap.note}" if cap is not None and cap.note else ""
            raise NotImplementedError(
                f"{self.provider} does not support {scope.value}-scope hooks "
                f"(supported: {sorted(s.value for s in self.supported_scopes()) or 'none'})"
                + reason
            )
        if not cap.supports(event):
            raise NotImplementedError(
                f"{self.provider} does not support the {event.value} hook at {scope.value} scope "
                f"(supported: {sorted(e.value for e in cap.events)})"
                + (f" — {cap.note}" if cap.note else "")
            )
        return cap

    # ── configuration ────────────────────────────────────────────────────────

    @abstractmethod
    async def configure(
        self,
        event: HookEventType | str,
        *,
        scope: Optional[HookScope] = None,
        matcher: Optional[dict[str, Any]] = None,
    ) -> HookInfo:
        """Install one hook. Idempotent. Raises for an unsupported cell."""

    @abstractmethod
    async def remove(self, event: HookEventType | str, *, scope: Optional[HookScope] = None) -> bool:
        """Remove one hook; return whether anything changed."""

    @abstractmethod
    async def list(self, *, scope: Optional[HookScope] = None) -> list[HookInfo]:
        """Hooks configured at ``scope``, including foreign ones where visible."""

    # ── callbacks + delivery ─────────────────────────────────────────────────

    @property
    @abstractmethod
    def target_key(self) -> str:
        """Registry key: process id for Process scope, provider name otherwise."""

    def set_callback(
        self,
        callback: AgentHookCallback,
        *,
        event: Optional[HookEventType] = None,
    ) -> Unsubscribe:
        """Subscribe to hooks on this target. ``event=None`` means every event."""
        return _callbacks.register(self.target_key, callback, event=event)

    async def deliver(self, data: AgentHookData) -> AgentHookResponse | None:
        """Run the callbacks for one inbound hook and return their answer."""
        raw = data.hook_data if isinstance(data.hook_data, dict) else {}
        name = raw.get("hook_event_name")
        event = HookEventType(name) if name in set(HookEventType) else None
        return await _callbacks.dispatch(self.target_key, data, event=event)

    def clear_callbacks(self) -> None:
        _callbacks.clear(self.target_key)


def normalize_event(event: HookEventType | str) -> HookEventType:
    """Coerce to ``HookEventType``, with a uniform error for a bad name."""
    try:
        return HookEventType(event)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"unknown hook event: {event!r}") from exc


def get_hook_manager(worker_type: Any = None) -> "HooksManager":
    """The GLOBAL hooks manager for a harness.

    Worker-type normalisation is delegated to ``get_driver`` so there is exactly
    one alias map in the codebase. Process-scoped hooks are reached through
    ``AgenticProcess.hooks`` instead — the target is the process, not the harness.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver
    from flow_sdk.builtin.hooks.global_manager import GlobalHooksManager

    return GlobalHooksManager(get_driver(worker_type))

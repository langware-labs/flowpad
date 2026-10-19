"""Global-scope hooks — a persisted file the harness discovers on its own.

User / Project / LocalProject. A hook here fires for EVERY run of that harness,
including runs Flowpad never launched; that is the defining property of the
scope, not a side effect.

Configuration is persisted exactly where it already was: an ``AgentHook`` row
(which Triggers bind to) projected into the harness file by a per-provider
writer. No new store, no new id scheme — the command string keeps carrying
``--hook-entry-id=<AgentHook.id>``, so entries already installed on disk keep
resolving.
"""

from __future__ import annotations

from typing import Any, Optional

from flow_sdk.builtin.hooks.manager import HooksManager, normalize_event
from flow_sdk.builtin.hooks.types import (
    AgentProvider,
    HookCapabilities,
    HookEventType,
    HookInfo,
    HookScope,
)

#: Driver name -> the provider value stored on an ``AgentHook`` row.
_PROVIDERS: dict[str, AgentProvider] = {"claude": AgentProvider.CLAUDE_CODE}


class GlobalHooksManager(HooksManager):
    """Hooks written into a harness settings file, for one provider."""

    default_scope = HookScope.USER

    def __init__(self, driver: Any) -> None:
        self._driver = driver

    @property
    def provider(self) -> str:  # type: ignore[override]
        return self._driver.name

    @property
    def target_key(self) -> str:
        return self.provider

    def capabilities(self) -> HookCapabilities:
        declare = getattr(self._driver, "hook_capabilities", None)
        if declare is None:
            return {}
        return {scope: cap for scope, cap in declare().items() if scope is not HookScope.PROCESS}

    def _entity_provider(self) -> AgentProvider:
        try:
            return _PROVIDERS[self.provider]
        except KeyError:  # pragma: no cover - guarded by require() first
            raise NotImplementedError(f"no global hook writer for {self.provider}") from None

    async def _find(self, event: HookEventType, scope: HookScope):
        from flow_sdk.builtin.agent_hook import AgentHook

        return await AgentHook.get_one(
            {
                "provider": self._entity_provider(),
                "hook_scope": scope,
                "event": event.value,
            }
        )

    async def configure(
        self,
        event: HookEventType | str,
        *,
        scope: Optional[HookScope] = None,
        matcher: Optional[dict[str, Any]] = None,
    ) -> HookInfo:
        from flow_sdk.builtin.agent_hook import AgentHook

        normalized = normalize_event(event)
        scope = scope or self.default_scope
        self.require(normalized, scope)

        hook = await self._find(normalized, scope)
        if hook is None:
            hook = AgentHook(
                name=f"{self.provider}:{scope.value}:{normalized.value}",
                provider=self._entity_provider(),
                hook_scope=scope,
                event=normalized.value,
                matcher=matcher,
                enabled=True,
            )
            await hook.save()
        elif matcher is not None and hook.matcher != matcher:
            hook.matcher = matcher
            await hook.save()

        await hook.apply()
        return HookInfo(
            event=normalized,
            scope=scope,
            provider=self.provider,
            hook_id=hook.id,
            matcher=hook.matcher,
        )

    async def remove(self, event: HookEventType | str, *, scope: Optional[HookScope] = None) -> bool:
        normalized = normalize_event(event)
        scope = scope or self.default_scope
        self.require(normalized, scope)
        hook = await self._find(normalized, scope)
        if hook is None:
            return False
        await hook.delete()  # unapply() runs first — see AgentHook.delete
        return True

    async def list(self, *, scope: Optional[HookScope] = None) -> list[HookInfo]:
        from flow_sdk.builtin.agent_hook import AgentHook

        scope = scope or self.default_scope
        if scope not in self.supported_scopes():
            raise NotImplementedError(f"{self.provider} does not support {scope.value}-scope hooks")
        rows = await AgentHook.get_all(
            {"provider": self._entity_provider(), "hook_scope": scope}
        )
        return [
            HookInfo(
                event=HookEventType(row.event),
                scope=scope,
                provider=self.provider,
                hook_id=row.id,
                matcher=row.matcher,
            )
            for row in (rows or [])
            if row.event in set(HookEventType)
        ]

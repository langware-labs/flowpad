"""Process-scope hooks — argv the launcher hands over, dying with the launch."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin.hooks.manager import HooksManager, normalize_event
from flow_sdk.builtin.hooks.types import HookCapabilities, HookEventType, HookInfo, HookScope

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess


class ProcessHooksManager(HooksManager):
    """Hooks bound to one ``AgenticProcess``.

    Configuration is persisted on the process row (``process_hook_events``) —
    the same field the restart snapshot hashes, so enabling a hook keeps flagging
    ``restart_required`` exactly as before. The launch artifacts themselves
    (plugin dir / ``-c`` overrides) are regenerated from that field at spawn time
    by ``driver.prepare_process_hooks``.
    """

    default_scope = HookScope.PROCESS

    def __init__(self, process: "AgenticProcess") -> None:
        self._process = process

    @property
    def provider(self) -> str:  # type: ignore[override]
        return self._process.driver.name

    @property
    def target_key(self) -> str:
        return str(self._process.id)

    def capabilities(self) -> HookCapabilities:
        declare = getattr(self._process.driver, "hook_capabilities", None)
        if declare is None:
            return {}
        return {scope: cap for scope, cap in declare().items() if scope is HookScope.PROCESS}

    async def _set(self, event: HookEventType | str, *, enabled: bool, scope: Optional[HookScope]) -> bool:
        normalized = normalize_event(event)
        self.require(normalized, scope)
        original = list(self._process.process_hook_events or [])
        updated = set(original)
        updated.add(normalized.value) if enabled else updated.discard(normalized.value)
        canonical = sorted(updated)
        if canonical == original:
            return False
        self._process.process_hook_events = canonical
        await self._process.save()
        return True

    async def configure(
        self,
        event: HookEventType | str,
        *,
        scope: Optional[HookScope] = None,
        matcher: Optional[dict[str, Any]] = None,
    ) -> HookInfo:
        normalized = normalize_event(event)
        await self._set(normalized, enabled=True, scope=scope)
        return HookInfo(
            event=normalized,
            scope=HookScope.PROCESS,
            provider=self.provider,
            hook_id=self.target_key,
            matcher=matcher,
        )

    async def remove(self, event: HookEventType | str, *, scope: Optional[HookScope] = None) -> bool:
        return await self._set(event, enabled=False, scope=scope)

    async def list(self, *, scope: Optional[HookScope] = None) -> list[HookInfo]:
        if scope is not None and scope is not HookScope.PROCESS:
            raise NotImplementedError(f"a process manager serves only process scope, not {scope.value}")
        return [
            HookInfo(
                event=HookEventType(value),
                scope=HookScope.PROCESS,
                provider=self.provider,
                hook_id=self.target_key,
            )
            for value in sorted(self._process.process_hook_events or [])
        ]

"""Per-harness hook capability declarations.

A driver owns its own declaration; this module only supplies the shared building
blocks so three vendors don't each hand-roll the same frozensets. A scope absent
from a driver's mapping is unsupported — ``HooksManager.configure`` raises
``NotImplementedError`` for it rather than installing a hook that can never fire.
"""

from __future__ import annotations

from flow_sdk.builtin.hooks.types import (
    ALL_HOOK_EVENTS,
    HookCapability,
    HookEventType,
    HookScope,
)

#: Events every V1 process-hook driver projects and normalizes today. Kept in one
#: place because all three vendors implement exactly this set — the lifecycle
#: pair plus the prompt hook.
PROCESS_EVENTS: frozenset[HookEventType] = frozenset(
    {
        HookEventType.SESSION_START,
        HookEventType.SESSION_END,
        HookEventType.USER_PROMPT_SUBMIT,
    }
)

#: Everything a settings-file harness can carry. The file format imposes no
#: per-event restriction — whatever the vendor fires, an entry can name.
GLOBAL_EVENTS: frozenset[HookEventType] = frozenset(ALL_HOOK_EVENTS)


def process_capability(*, response_events: frozenset[HookEventType] = frozenset()) -> HookCapability:
    """The standard Process-scope declaration."""
    return HookCapability(events=PROCESS_EVENTS, response_events=response_events)


def global_capability(
    *,
    events: frozenset[HookEventType] = GLOBAL_EVENTS,
    response_events: frozenset[HookEventType] = frozenset(),
    note: str = "",
) -> HookCapability:
    """The standard declaration for one settings-file scope."""
    return HookCapability(events=events, response_events=response_events, note=note)


def unsupported(reason: str) -> HookCapability:
    """Declare a scope the vendor cannot serve, WITH the reason.

    An absent scope and an explicitly-unsupported one both raise, but this one
    carries why — "the vendor has no mechanism" reads very differently from
    "we have not built it yet", and the difference belongs in the error a
    caller sees rather than in a comment nobody reads.
    """
    return HookCapability(events=frozenset(), note=reason)


def settings_file_scopes(**kwargs) -> dict[HookScope, HookCapability]:
    """User + Project + LocalProject, all served by one settings-file writer."""
    cap = global_capability(**kwargs)
    return {
        HookScope.USER: cap,
        HookScope.PROJECT: cap,
        HookScope.LOCAL_PROJECT: cap,
    }

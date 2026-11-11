"""A scripted hub behind ``HubProxy.call`` — the one seam every typed hub call goes through.

``try_call``, ``download``/``upload`` (without progress) and ``exists`` all ride ``call``, so
patching ``call`` alone covers them, with their real None / raise / tri-state contracts intact.

    hub = FakeHub()
    hub.on("GET", "conversation", action="members", answer=[...])
    hub.on("POST", "conversation", action="join", fail=HubFailureKind.OFFLINE)
    hub.install(monkeypatch)
    ...
    assert hub.called("POST", "conversation", action="members")
    assert hub.calls[-1].payload == {...}
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind

_ANY = object()


@dataclass
class HubCall:
    method: str
    entity_type: str
    entity_id: str | None
    action: str | None
    sub_path: str | None
    kwargs: dict[str, Any] = field(default_factory=dict)

    @property
    def payload(self) -> Any:
        return self.kwargs.get("payload")


@dataclass
class _Route:
    method: str
    entity_type: Any
    entity_id: Any
    action: Any
    sub_path: Any
    answer: Any
    fail: HubError | None

    def matches(self, c: HubCall) -> bool:
        return (
            self.method == c.method
            and self.entity_type in (_ANY, c.entity_type)
            and self.entity_id in (_ANY, c.entity_id)
            and self.action in (_ANY, c.action)
            and self.sub_path in (_ANY, c.sub_path)
        )


_STATUS = {
    HubFailureKind.OFFLINE: 0,
    HubFailureKind.SIGNED_OUT: 401,
    HubFailureKind.NOT_CONFIGURED: 0,
    HubFailureKind.SERVER_ERROR: 500,
}


def hub_error(fail: HubFailureKind | int | HubError, reason: str = "") -> HubError:
    """A ``HubError`` from a kind (OFFLINE, SIGNED_OUT, …), a bare status (404, 409) or itself."""
    if isinstance(fail, HubError):
        return fail
    if isinstance(fail, int):
        return HubError(fail, reason or f"HTTP {fail}")
    return HubError(_STATUS.get(fail, 400), reason or str(fail), kind=fail)


class FakeHub:
    """Records every ``HubProxy.call`` and answers from the routes given with ``on``.

    An unrouted call raises ``HubError(404)`` — the hub's own answer for a path it does not
    serve — so a test never passes because a call it did not expect silently got ``{}``.
    """

    def __init__(self) -> None:
        self.calls: list[HubCall] = []
        self._routes: list[_Route] = []

    def on(
        self,
        method: str,
        entity_type: Any = _ANY,
        entity_id: Any = _ANY,
        *,
        action: Any = _ANY,
        sub_path: Any = _ANY,
        answer: Any | Callable[[HubCall], Any] = None,
        fail: HubFailureKind | int | HubError | None = None,
    ) -> "FakeHub":
        """Route a call. The latest matching route wins. ``answer`` may be a function of the call."""
        etype = getattr(entity_type, "value", entity_type)
        self._routes.append(
            _Route(method.upper(), etype, entity_id, action, sub_path, answer, hub_error(fail) if fail is not None else None)
        )
        return self

    def called(self, method: str, entity_type: Any = _ANY, entity_id: Any = _ANY, *, action: Any = _ANY) -> list[HubCall]:
        probe = _Route(method.upper(), getattr(entity_type, "value", entity_type), entity_id, action, _ANY, None, None)
        return [c for c in self.calls if probe.matches(c)]

    async def call(
        self,
        method: str,
        entity_type: Any,
        entity_id: str | None = None,
        action: str | None = None,
        sub_path: str | None = None,
        **kwargs: Any,
    ) -> Any:
        c = HubCall(method.upper(), str(getattr(entity_type, "value", entity_type)), entity_id, action, sub_path, kwargs)
        self.calls.append(c)
        for route in reversed(self._routes):
            if route.matches(c):
                if route.fail is not None:
                    raise route.fail
                return route.answer(c) if callable(route.answer) else ({} if route.answer is None else route.answer)
        raise HubError(404, f"unrouted fake hub call: {c.method} {c.entity_type}/{c.entity_id}/{c.action}")

    def install(self, monkeypatch) -> "FakeHub":
        monkeypatch.setattr(HubProxy, "call", self.call)
        return self

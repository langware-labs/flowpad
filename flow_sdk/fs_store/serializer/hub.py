"""``HubSerializer`` — the ``"hub"`` origin kind: the body POSTed to the hub.

The body is every field not declared ``PRIVATE`` (never leaves this machine)
or ``HUB_READ`` (the hub owns it). A disk-only field that is NOT excluded by
those declarations RAISES — a ``FileRef`` cannot ride a JSON body, and the
hub must never receive a path that means nothing there. ``share`` /
``create_child`` still do the HTTP; this decides what they send.
"""

from __future__ import annotations

from functools import cache
from typing import Any, ClassVar, Optional

from flow_sdk.fs_store.origin.fs_origin import FSOrigin
from flow_sdk.fs_store.serializer.db import refuse_disk_only


@cache
def hub_names(cls: type) -> dict[str, str]:
    """``{field: wire_name}`` for the fields the hub reads under another key
    (``APIField(hub_name=...)``). Once per class."""
    from flow_sdk.api.api_types.api_field import _extra  # noqa: PLC0415

    return {n: w for n, f in cls.model_fields.items() if (w := _extra(f).get("hub_name"))}


@cache
def origin_fields(cls: type) -> tuple[str, ...]:
    """The fields typed as an origin — the only ones whose VALUE may refuse to travel."""
    return tuple(n for n, f in cls.model_fields.items() if "Origin" in repr(f.annotation))


class HubSerializer:
    kind: ClassVar[str] = "hub"

    def store(self, obj: Any, origin: FSOrigin) -> FSOrigin:
        return origin.model_copy(update={"id": str(getattr(obj, "id", "") or "")})

    def body(self, obj: Any) -> dict[str, Any]:
        cls = type(obj)
        excluded = set(cls.fields_not_sent_to_hub())
        refuse_disk_only(cls, tuple(n for n in cls.model_fields if n not in excluded), "a hub body")
        body = obj.model_dump(mode="json", exclude_none=True, exclude=excluded)
        for name in origin_fields(cls):
            # A machine-local pointer never leaves this machine — a value fact,
            # which no per-field declaration can express.
            if name in body and not getattr(getattr(obj, name, None), "transportable", True):
                body.pop(name)
        for name, wire in hub_names(cls).items():
            if name in body:
                body[wire] = body.pop(name)
        return body

    def load(self, cls: type, origin: FSOrigin, *, entity_id: Optional[str] = None) -> Any:
        raise NotImplementedError("the bridge composes the payload; use HubSerializer.from_payload")

    @staticmethod
    def unwire(cls: type, payload: dict[str, Any]) -> dict[str, Any]:
        """The hub payload with wire names mapped back to field names."""
        lifted = {name: payload[wire] for name, wire in hub_names(cls).items() if wire in payload and name not in payload}
        return {**payload, **lifted} if lifted else payload

    @staticmethod
    def from_payload(cls: type, payload: dict[str, Any]) -> Any:
        return cls.model_validate(HubSerializer.unwire(cls, payload))

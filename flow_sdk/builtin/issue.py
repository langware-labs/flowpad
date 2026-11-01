"""``Issue`` — something stopped working, seen from a desktop: a read-only mirror of the hub's row.

The hub raises and resolves every issue (a budget ran out, a credential was refused, a deployment's turns
fail) and decides who may read it; this box only reads. Hub-only like ``Webhook``: there are no local rows,
a desktop proxies every ``issue`` request to the hub (``server/routes/_hub_reflect.decide``), and
:meth:`Issue.get_all` / :meth:`Issue.get_by_id` read the hub directly.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class Issue(Entity):
    _api_visible: ClassVar[bool] = False
    _hub_only: ClassVar[bool] = True

    type: str = APIField(default=EntityType.ISSUE.value)
    #: What must be fixed (an agent, a deployment, an llm_endpoint, a credential, any entity).
    subject_typeid: str = APIField(default="")
    #: A fixed code: ``budget_exhausted``, ``credential_invalid``, ``turns_failing``, ``service_down``, …
    kind: str = APIField(default="")
    #: ``"error"`` | ``"warning"``.
    severity: str = APIField(default="error")
    title: str = APIField(default="")
    detail: str = APIField(default="")
    #: ``{"label": …, "pointer": …}`` — what to open to fix it.
    fix: Optional[dict] = APIField(default=None)
    #: What the subject's problem stops (e.g. the deployments a budget funds), as typeids.
    affected: list[str] = APIField(default_factory=list)
    #: ``"open"`` | ``"resolved"``.
    status: str = APIField(default="open")
    opened_at: float = APIField(default=0.0)
    resolved_at: Optional[float] = APIField(default=None)
    last_notified_at: Optional[float] = APIField(default=None)
    count: int = APIField(default=1)

    def is_file_backed(self) -> bool:
        return False

    async def save(self, *args, **kwargs):  # noqa: D401 — a guard, not a verb
        """Refuse: an issue is the hub's row, raised and resolved there."""
        raise ValueError("an issue is the hub's row — it has no local copy to save")

    @classmethod
    def _from_hub(cls, row: Any) -> Optional["Issue"]:
        if not isinstance(row, dict):
            return None
        return cls(**{k: v for k, v in row.items() if k in cls.model_fields})

    @classmethod
    async def get_all(cls, entities_filter: Any = None, source_entity: Any = None) -> list["Issue"]:  # type: ignore[override]
        """The issues the signed-in hub user may read — every page of the hub's listing; ``[]`` signed out or
        offline. *entities_filter* is a ``{"match": …, "order_by": …}`` dict (or a bare match dict)."""
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

        spec = entities_filter
        if spec is not None and not isinstance(spec, dict):
            spec = spec.model_dump(mode="json", exclude_none=True)
        spec = dict(spec or {})
        match = spec.get("match") if "match" in spec or "order_by" in spec else spec
        walk = await HubProxy.walk(cls.get_type(), match=match or {}, order_by=spec.get("order_by"))
        return [issue for issue in (cls._from_hub(row) for row in walk.rows) if issue is not None]

    @classmethod
    async def get_by_id(cls, entity_id: str, *args, **kwargs) -> Optional["Issue"]:  # type: ignore[override]
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

        body = await HubProxy.try_call("GET", cls.get_type(), str(entity_id))
        return cls._from_hub(body.get("data", body) if isinstance(body, dict) else None)

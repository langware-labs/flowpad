from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity, action
from flow_sdk.core.capabilities import (
    CapabilityResult,
    CapabilitySpec,
    get_capability_registry,
    get_default_capability_specs,
)
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.responses.response import ApiSuccessResponse


def capability_id_for_kind(kind: str) -> str:
    return mint_uuid(f"flow-sdk:capability:{kind}")


class Capability(Entity):
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "BadgeCheck"

    type: str = APIField(default="capability")
    name: str = APIField(default="")
    kind: str = APIField(default="")
    description: str = APIField(default="")
    icon: str = APIField(default="BadgeCheck")
    homepage_url: str | None = APIField(default=None)
    dependent_capability_kinds: list[str] = APIField(default_factory=list)
    # CapabilityReference pointer: kind of the capability this row delegates
    # to (e.g. the Default harness row referencing harness.claude.cli).
    # User-switchable — seeded from the spec on creation only, never
    # reconciled back, so ensure_seeded() can't clobber the user's pick.
    reference_kind: str | None = APIField(default=None)
    # Prompt the install agentic process runs with (None → registry default).
    install_prompt: str | None = APIField(default=None)
    last_check: dict[str, Any] | None = APIField(default=None)
    last_install: dict[str, Any] | None = APIField(default=None)
    last_test: dict[str, Any] | None = APIField(default=None)

    @classmethod
    def from_spec(cls, spec: CapabilitySpec) -> "Capability":
        return cls(
            id=capability_id_for_kind(spec.kind),
            name=spec.name,
            kind=spec.kind,
            description=spec.description,
            icon=spec.icon,
            homepage_url=spec.homepage_url,
            dependent_capability_kinds=list(spec.dependent_capability_kinds),
            reference_kind=spec.reference_kind,
            install_prompt=spec.install_prompt,
            system=True,
        )

    # Once-per-process guard: the spec→row reconcile is idempotent but costs a
    # DB read per spec, and ensure_seeded is called from every classmethod
    # accessor. First successful run flips this; later calls are free.
    _seeded_once: ClassVar[bool] = False

    @classmethod
    async def ensure_seeded(cls) -> list["Capability"]:
        if cls._seeded_once:
            return []
        seeded: list[Capability] = []
        for spec in get_default_capability_specs():
            expected = cls.from_spec(spec)
            existing = await cls._db.get_by_id(expected.id, cls.get_type())
            if existing is None:
                seeded.append(await expected.save(notify=False))
                continue
            changed = False
            for field in (
                "name",
                "kind",
                "description",
                "icon",
                "homepage_url",
                "dependent_capability_kinds",
                "install_prompt",
                "uname",
                "system",
            ):
                expected_value = getattr(expected, field)
                if getattr(existing, field) != expected_value:
                    setattr(existing, field, expected_value)
                    changed = True
            seeded.append(await existing.save(notify=False) if changed else existing)
        cls._seeded_once = True
        return seeded

    @classmethod
    async def get_by_kind(cls, kind: str) -> "Capability | None":
        await cls.ensure_seeded()
        return await cls._db.get_by_id(capability_id_for_kind(kind), cls.get_type())

    @classmethod
    async def get_by_id(cls, eid: str) -> "Capability | None":
        await cls.ensure_seeded()
        return await super().get_by_id(eid)

    @classmethod
    async def get_all(
        cls,
        entities_filter: QueryFilter | dict | None = None,
        source_entity=None,
    ) -> list["Capability"]:
        await cls.ensure_seeded()
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        if entities_filter is None:
            entities_filter = QueryFilter(type=cls.get_type())
        return await super().get_all(entities_filter, source_entity)

    async def _record_result(self, field: str, result: CapabilityResult) -> None:
        setattr(self, field, result.model_dump(mode="json"))
        await self.save(notify=True)

    @action.post(action_name="check")
    async def check_action(self) -> ApiSuccessResponse:
        result = await get_capability_registry().check(self.kind)
        await self._record_result("last_check", result.result)
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

    @action.post(action_name="install")
    async def install_action(self) -> ApiSuccessResponse:
        result = await get_capability_registry().install(self.kind)
        await self._record_result("last_install", result.result)
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

    @action.post(action_name="test")
    async def test_action(self) -> ApiSuccessResponse:
        result = await get_capability_registry().test(self.kind)
        await self._record_result("last_test", result.result)
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

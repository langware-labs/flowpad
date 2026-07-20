from __future__ import annotations

import weakref
from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity, action
from flow_sdk.core.capabilities import (
    CapabilityResult,
    CapabilitySpec,
    get_capability_registry,
    get_default_capability_specs,
)
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


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
    # Whether FlowPad can actually use this capability once available (mirror of
    # CapabilitySpec.runnable). False for MCP servers configured for agents
    # FlowPad never spawns (cursor/windsurf/vscode/claude_desktop).
    runnable: bool = APIField(default=True)
    # CapabilityReference pointer: kind of the capability this row delegates
    # to (e.g. the Default harness row referencing harness.claude.cli).
    # User-switchable — seeded from the spec on creation only, never
    # reconciled back, so ensure_seeded() can't clobber the user's pick.
    reference_kind: str | None = APIField(default=None)
    # Prompt the install agentic process runs with (None → registry default).
    install_prompt: str | None = APIField(default=None)
    # Discovered typed value (mirror of the discovery dict — see
    # core/capabilities/discovery.py). None ⇔ capability absent. value_type
    # is the spec's static RecordType (e.g. "folder" → value is the FSRef
    # dict of the CLI's bin dir). The capabilities window renders these, so
    # what the UI shows IS what workers consume.
    value: dict[str, Any] | None = APIField(default=None)
    value_type: str | None = APIField(default=None)
    last_check: dict[str, Any] | None = APIField(default=None)
    last_install: dict[str, Any] | None = APIField(default=None)
    last_test: dict[str, Any] | None = APIField(default=None)
    # Device-login session state — runtime-only, broadcast but never persisted
    # (same shape as AgenticProcess.connection_id / Tab.status). Mirrors the
    # live DeviceLoginSession for this harness kind; None/idle when no login
    # is in flight.
    login_state: str | None = APIField(default=None, persist=Persist.FALSE)
    login_url: str | None = APIField(default=None, persist=Persist.FALSE)
    login_code: str | None = APIField(default=None, persist=Persist.FALSE)
    login_accepts_code: bool | None = APIField(default=None, persist=Persist.FALSE)
    login_message: str | None = APIField(default=None, persist=Persist.FALSE)
    # How this harness authenticates its worker: "device" (vendor device login,
    # default) or "api" (a stored LLM-provider key — see flow_sdk.cli.auth.lm_api_keys
    # and cli_drivers/api_auth.py). Persisted + user-switchable; like reference_kind
    # it is deliberately NOT in the ensure_seeded reconcile list, so seeding never
    # clobbers the user's choice.
    auth_mode: str = APIField(default="device")
    # Chosen LMApiProvider value when auth_mode == "api"; None → the driver's
    # ApiAuthSpec.default_provider.
    api_provider: str | None = APIField(default=None)
    # User overrides for the tier→model mapping, layered over the driver's
    # ApiAuthSpec.tier_models code defaults: {provider: {name: model_slug}} where
    # name is a tier (sm/md/lg) or a custom option name. Persisted + user-editable;
    # like auth_mode it is NOT in the ensure_seeded reconcile list.
    model_map: dict[str, Any] = APIField(default_factory=dict)

    @classmethod
    def from_spec(cls, spec: CapabilitySpec) -> "Capability":
        return cls(
            id=capability_id_for_kind(spec.kind),
            name=spec.name,
            kind=spec.kind,
            description=spec.description,
            icon=spec.icon,
            homepage_url=spec.homepage_url,
            value_type=spec.value_type,
            dependent_capability_kinds=list(spec.dependent_capability_kinds),
            runnable=spec.runnable,
            reference_kind=spec.reference_kind,
            install_prompt=spec.install_prompt,
            system=True,
        )

    # Once-per-driver guard: the spec→row reconcile is idempotent but costs a
    # DB read per spec, and ensure_seeded is called from every classmethod
    # accessor. Keyed on the live driver object (not a process-global bool)
    # because every DB swap (reinit_db "Switch DB", clear_all_data factory
    # reset, instance override) constructs a fresh driver — the new DB starts
    # unseeded and must not inherit the old driver's "already seeded" state.
    _seeded_dbs: ClassVar[weakref.WeakSet] = weakref.WeakSet()

    @classmethod
    async def ensure_seeded(cls) -> list["Capability"]:
        db = cls._db
        if db in cls._seeded_dbs:
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
                "value_type",
                "dependent_capability_kinds",
                "runnable",
                "install_prompt",
                "uname",
                "system",
            ):
                expected_value = getattr(expected, field)
                if getattr(existing, field) != expected_value:
                    setattr(existing, field, expected_value)
                    changed = True
            seeded.append(await existing.save(notify=False) if changed else existing)
        cls._seeded_dbs.add(db)
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
        # Check = refresh: re-run discovery from scratch for this kind (the
        # capability window's Check/Refresh button). ``run_discovery`` already
        # mirrors value + last_check onto the row and broadcasts the update, so
        # we just read the fresh result for the response — no second save/notify.
        from flow_sdk.core.capabilities.discovery import run_discovery
        from flow_sdk.core.capabilities.models import is_mcp_capability_kind

        # MCP capabilities are dynamic — re-derive from indexed records first so
        # a newly-configured server appears (and a removed one is pruned) on
        # manual refresh, before discovery mirrors the result.
        if is_mcp_capability_kind(self.kind):
            from flow_sdk.core.capabilities.mcp import reconcile_mcp_capabilities

            await reconcile_mcp_capabilities()
        await run_discovery([self.kind])
        result = await get_capability_registry().check(self.kind)
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

    # ── Device login (harness CLIs) ─────────────────────────────────────────

    def _login_worker_type(self) -> str | None:
        from flow_sdk.core.capabilities.registry import worker_type_for_kind

        return worker_type_for_kind(self.kind)

    def _set_login_fields(
        self,
        *,
        state: str | None,
        url: str | None = None,
        code: str | None = None,
        accepts_code: bool | None = None,
        message: str | None = None,
    ) -> None:
        self.login_state = state
        self.login_url = url
        self.login_code = code
        self.login_accepts_code = accepts_code
        self.login_message = message

    async def _apply_login_session(self, session) -> None:
        """Mirror a DeviceLoginSession onto the transient login_* fields and
        broadcast (no DB write — the fields are runtime-only)."""
        snapshot = session.to_json()
        self._set_login_fields(
            state=snapshot["state"],
            url=snapshot["url"],
            code=snapshot["code"],
            accepts_code=snapshot["accepts_code_paste"],
            message=snapshot["message"],
        )
        await self.notify_updated()

    @action.post(action_name="device-login")
    async def device_login_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Start (or restart) this harness CLI's login flow.

        Idempotent: the session pre-probes and short-circuits to
        ``authenticated`` when the CLI already holds credentials, so a click
        never wastes a one-time device code.
        """
        worker_type = self._login_worker_type()
        if worker_type is None:
            return ApiFailResponse(message=f"capability {self.kind!r} has no device login")
        from flow_sdk.builtin.agentic_process.cli_drivers.device_login import start_device_login

        session = await start_device_login(worker_type, on_change=self._apply_login_session)
        await self._apply_login_session(session)
        return ApiSuccessResponse(data=session.to_json())

    @action.post(action_name="device-login-code")
    async def device_login_code_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Inject the browser-shown code into the login PTY (paste-back flows)."""
        from flow_sdk.builtin.agentic_process.cli_drivers.device_login import get_device_login_session
        from flow_sdk.request_context.methods import get_current_request_info

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else None
        code = str((body or {}).get("code", "")).strip()
        worker_type = self._login_worker_type()
        session = get_device_login_session(worker_type) if worker_type else None
        if not code or session is None or not session.submit_code(code):
            return ApiFailResponse(message="no login awaiting a code")
        return ApiSuccessResponse(data={"submitted": True})

    @action.post(action_name="device-login-cancel")
    async def device_login_cancel_action(self) -> ApiSuccessResponse:
        from flow_sdk.builtin.agentic_process.cli_drivers.device_login import get_device_login_session

        worker_type = self._login_worker_type()
        session = get_device_login_session(worker_type) if worker_type else None
        if session is not None:
            session.cancel()
        self._set_login_fields(state=None)
        await self.notify_updated()
        return ApiSuccessResponse(data={"cancelled": session is not None})

    @action.get(action_name="auth-status")
    async def auth_status_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Cheap login-state probe (no version run) — the startup gate's check.

        Mirrors the result onto ``login_state`` (authenticated/idle) and
        broadcasts so every surface agrees without waiting for a full test.
        """
        worker_type = self._login_worker_type()
        if worker_type is None:
            return ApiFailResponse(message=f"capability {self.kind!r} has no worker auth")
        from flow_sdk.builtin.agentic_process.cli_drivers import get_driver
        from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import driver_api_auth_spec
        from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
            WorkerAuthResult,
            WorkerAuthStatus,
        )

        spec = driver_api_auth_spec(worker_type)
        if self.auth_mode == "api" and spec is not None:
            # API-key auth: the harness runs on a stored LLM-provider key, not the
            # vendor device login. "logged_in" ⇔ a key is stored (present but not
            # vendor-validated, so never `verified`). Surface the harness's
            # supported providers so the UI can offer only possible outcomes.
            from flow_sdk.cli.auth.lm_api_keys import get_lm_api

            provider = self.api_provider or spec.default_provider.value
            has_key = bool(get_lm_api(provider))
            result = WorkerAuthResult(
                status=WorkerAuthStatus.LOGGED_IN if has_key else WorkerAuthStatus.LOGGED_OUT,
                verified=False,
                auth_mode="api",
                message=(
                    f"Using {provider} API key" if has_key else f"No {provider} API key configured"
                ),
                details={"provider": provider},
            )
        else:
            result = await get_driver(worker_type).auth_probe()
        # Surface the harness's supported API providers regardless of mode, so the
        # modal can offer the key section / provider select for any harness.
        if spec is not None:
            result.details = {
                **result.details,
                "supported_providers": [p.value for p in spec.supported_providers],
            }
        # Don't clobber a login in flight; only broadcast when the mirror
        # actually changes (a no-op probe shouldn't emit a WS frame).
        if self.login_state not in ("awaiting_user", "starting"):
            new_state = "authenticated" if result.status.value == "logged_in" else "idle"
            if new_state != self.login_state or result.message != self.login_message:
                self.login_state = new_state
                self.login_message = result.message
                await self.notify_updated()
        return ApiSuccessResponse(data=result.to_json())

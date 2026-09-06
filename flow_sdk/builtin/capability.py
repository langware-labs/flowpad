from __future__ import annotations

import weakref
from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.api.api_types.identifier import mint_uuid

# ``auth_probe`` is stdlib-only, so this one cli_drivers import can live at
# module level — the lazy imports elsewhere in this file exist for the heavy
# siblings (``get_driver``, ``device_login``), not for this.
from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    DeviceLoginState,
    WorkerAuthStatus,
)
from flow_sdk.core import Entity, action
from flow_sdk.core.capabilities import (
    CapabilityResult,
    CapabilitySpec,
    CapabilityState,
    get_capability_registry,
    get_default_capability_specs,
)
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


def capability_id_for_kind(kind: str, scope_type: str | None = None, scope_id: str | None = None) -> str:
    scope = f":{scope_type or ''}:{scope_id or ''}"
    return mint_uuid(f"flow-sdk:capability:{kind}{scope}")


async def restamp_capability_state(kind: str, *, attempted: bool = True) -> None:
    """Re-check a capability and persist its four-state verdict.

    For out-of-band credential changes the discovery sweep can't see coming —
    e.g. GitHub OAuth connect/disconnect flips source_control.git.github without
    any CLI changing on disk. Best-effort: never raises."""
    try:
        row = await Capability.get_by_kind(kind)
        if row is None:
            return
        check = await get_capability_registry().test(kind)
        row.last_check = check.result.model_dump(mode="json")
        row.state = row.derive_state(check.result, attempted=attempted)
        await row.save(notify=True)
    except Exception:
        import logging

        logging.getLogger(__name__).exception("restamp_capability_state failed for %s", kind)


class Capability(Entity):
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "BadgeCheck"

    type: str = APIField(default="capability")
    name: str = APIField(default="")
    kind: str = APIField(default="")
    scope_type: str | None = APIField(default=None)
    scope_id: str | None = APIField(default=None)
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
    # The install one-liner for THIS machine, resolved from the spec's
    # per-platform table (CapabilitySpec.install_command). None → no unattended
    # installer for this capability/platform, and the UI offers no auto-install.
    install_command: str | None = APIField(default=None)
    # Discovered typed value (mirror of the discovery dict — see
    # core/capabilities/discovery.py). None ⇔ capability absent. value_type
    # is the spec's static RecordType (e.g. "folder" → value is the FSRef
    # dict of the CLI's bin dir). The capabilities window renders these, so
    # what the UI shows IS what workers consume.
    value: dict[str, Any] | None = APIField(default=None)
    value_type: str | None = APIField(default=None)
    # Four-state readiness (CapabilityState): available / not_available /
    # none / error. Runtime progress like reference_kind/auth_mode — NOT in the
    # ensure_seeded reconcile list, so seeding never resets it. Written via
    # derive_state() by discovery mirroring, the explicit verbs, and the
    # install monitor.
    state: str = APIField(default=CapabilityState.NONE.value)
    last_check: dict[str, Any] | None = APIField(default=None)
    last_setup: dict[str, Any] | None = APIField(default=None)
    last_test: dict[str, Any] | None = APIField(default=None)
    # Device-login session state — ``Persist.FALSE``: DB-only, never mirrored
    # into metadata.json (same shape as AgenticProcess.connection_id /
    # Tab.status). Mirrors the live DeviceLoginSession for this harness kind;
    # None/idle when no login is in flight. ``login_state`` is the exception to
    # "broadcast, never written": the startup sweep resolves and SAVES it
    # (``discovery._resolve_login_states``), because the spawn resolver reads it
    # back off a freshly-loaded row and would otherwise never see the verdict.
    login_state: DeviceLoginState | None = APIField(default=None, persist=Persist.FALSE)
    login_url: str | None = APIField(default=None, persist=Persist.FALSE)
    login_code: str | None = APIField(default=None, persist=Persist.FALSE)
    login_accepts_code: bool | None = APIField(default=None, persist=Persist.FALSE)
    login_message: str | None = APIField(default=None, persist=Persist.FALSE)
    # WHO is signed in and on WHAT plan, when the vendor says — claude reports an
    # email and a subscription type, the others report neither. Runtime-only like
    # the rest of this block and written by the same mirror, so the account line
    # and the status can never disagree about the same probe.
    login_identity: str | None = APIField(default=None, persist=Persist.FALSE)
    login_plan: str | None = APIField(default=None, persist=Persist.FALSE)
    # Has the harness ITSELF refused a turn since the last successful login?
    # Runtime-only like the rest of the login_* block. This is the evidence
    # ranking that keeps a weak signal from overwriting a strong one: a turn is
    # the only thing that tests whether a credential WORKS, while the auth probe
    # only tests whether one EXISTS (see ``probe_claude_auth`` — it never asks
    # the server). Without this marker the probe's presence-only "yes" flipped a
    # witnessed sign-out straight back to "authenticated" on the next poll.
    #
    # Nullable, and that is load-bearing: like every runtime login_* field this
    # is set in memory and BROADCAST, never written by ``save()``, so a row
    # rebuilt from the DB — which is what ``GET /graph/capability`` serves, and
    # what the frontend's `mutateAndRecheck` re-lists on every default-assistant
    # or auth-mode change — knows nothing about it. Its None siblings drop out of
    # the payload (``exclude_none``) and so cannot overwrite the live value a
    # broadcast delivered; a ``False`` default shipped on every refetch and DID,
    # silently retracting a refusal nobody had retracted. None means "this row
    # has no opinion"; only an actual state change sends True/False.
    login_denied: bool | None = APIField(default=None, persist=Persist.FALSE)
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
            install_command=spec.install_command,
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
            existing = await db.get_by_id(expected.id, cls.get_type())
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
                # Platform-resolved, so it MUST reconcile: a row seeded on one
                # machine (or before the command existed) otherwise keeps a
                # command for the wrong OS forever.
                "install_command",
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
    async def get_by_kind(
        cls, kind: str, scope_type: str | None = None, scope_id: str | None = None
    ) -> "Capability | None":
        await cls.ensure_seeded()
        return await cls._db.get_by_id(capability_id_for_kind(kind, scope_type, scope_id), cls.get_type())

    @classmethod
    async def get_or_create_scoped(cls, kind: str, scope_type: str, scope_id: str) -> "Capability":
        existing = await cls.get_by_kind(kind, scope_type, scope_id)
        if existing is not None:
            return existing
        spec = next(spec for spec in get_default_capability_specs() if spec.kind == kind)
        row = cls.from_spec(spec)
        row.id = capability_id_for_kind(kind, scope_type, scope_id)
        row.scope_type = scope_type
        row.scope_id = scope_id
        return await row.save(notify=False)

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

    def derive_state(self, result: CapabilityResult, *, attempted: bool = False) -> str:
        """Map a probe result to the persisted four-state readiness.

        NONE → NOT_AVAILABLE only when the user has engaged with the
        capability (an explicit verb passes ``attempted=True``, or the row
        already left NONE, or an install ran). Passive background discovery
        of an absent capability keeps "never tried" honest.
        """
        if result.state == CapabilityState.ERROR:
            return CapabilityState.ERROR.value
        if result.available:
            return CapabilityState.AVAILABLE.value
        engaged = attempted or self.state != CapabilityState.NONE or self.last_setup is not None
        return CapabilityState.NOT_AVAILABLE.value if engaged else CapabilityState.NONE.value

    async def _record_result(
        self,
        field: str,
        result: CapabilityResult,
        *,
        attempted: bool = False,
        stamp_state: bool = True,
    ) -> None:
        # stamp_state=False for in-flight results (install start): the state
        # must not flip to NOT_AVAILABLE while the install process is still
        # running — the install monitor writes the real post-install state.
        setattr(self, field, result.model_dump(mode="json"))
        if stamp_state:
            self.state = self.derive_state(result, attempted=attempted)
        await self.save(notify=True)

    @action.post(action_name="test")
    async def test_action(self) -> ApiSuccessResponse:
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
        result = await get_capability_registry().test(self.kind)
        # An explicit Check is user engagement: it may promote NONE →
        # NOT_AVAILABLE (unlike the passive discovery mirror above).
        new_state = self.derive_state(result.result, attempted=True)
        if new_state != self.state:
            self.state = new_state
            await self.save(notify=True)
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

    @action.post(action_name="setup")
    async def setup_action(self) -> ApiSuccessResponse:
        result = await get_capability_registry().setup(self.kind)
        await self._record_result(
            "last_setup", result.result, attempted=True, stamp_state=result.result.process_id is None
        )
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

    # ── Device login (harness CLIs) ─────────────────────────────────────────

    def _login_worker_type(self) -> str | None:
        from flow_sdk.core.capabilities.registry import worker_type_for_kind

        return worker_type_for_kind(self.kind)

    def _device_login_runner(self):
        """The runner behind this kind, when it drives its OWN device login
        (non-worker CLIs like gh expose ``device_login_spec`` + ``login_probe``
        — see GhCliCapabilityRunner). None for worker-backed harnesses."""
        try:
            runner = get_capability_registry().get(self.kind)
        except KeyError:
            return None
        if getattr(runner, "device_login_spec", None) is None:
            return None
        return runner if hasattr(runner, "login_probe") else None

    def _login_session_key(self) -> str | None:
        """Key into the device-login session registry: the worker type for
        harness CLIs, the capability kind for spec-driven runners."""
        worker_type = self._login_worker_type()
        if worker_type is not None:
            return worker_type
        return self.kind if self._device_login_runner() is not None else None

    async def _apply_login_session_and_refresh(self, session) -> None:
        """Spec-driven runners have no worker auth pipeline: when the login
        session lands on ``authenticated``, re-discover this kind so the
        availability + state flip and broadcast."""
        await self._apply_login_session(session)
        if session.state is DeviceLoginState.AUTHENTICATED:
            from flow_sdk.core.capabilities.discovery import run_discovery

            await run_discovery([self.kind])

    def _set_login_fields(
        self,
        *,
        state: DeviceLoginState | None,
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
        if DeviceLoginState(snapshot["state"]) is DeviceLoginState.AUTHENTICATED:
            # A completed login is newer and stronger evidence than the refusal
            # that prompted it.
            self.login_denied = False
        self._set_login_fields(
            state=DeviceLoginState(snapshot["state"]),
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
        from flow_sdk.builtin.agentic_process.cli_drivers.device_login import start_device_login

        worker_type = self._login_worker_type()
        if worker_type is not None:
            session = await start_device_login(worker_type, on_change=self._apply_login_session)
            await self._apply_login_session(session)
            return ApiSuccessResponse(data=session.to_json())
        runner = self._device_login_runner()
        if runner is None:
            return ApiFailResponse(message=f"capability {self.kind!r} has no device login")
        # Spec-driven login (no worker driver): session keyed by kind; probe +
        # spec come from the runner; success re-discovers the kind.
        session = await start_device_login(
            self.kind,
            on_change=self._apply_login_session_and_refresh,
            spec=runner.device_login_spec,
            probe_fn=runner.login_probe,
        )
        await self._apply_login_session_and_refresh(session)
        return ApiSuccessResponse(data=session.to_json())

    @action.post(action_name="device-login-code")
    async def device_login_code_action(self) -> ApiSuccessResponse | ApiFailResponse:
        """Inject the browser-shown code into the login PTY (paste-back flows)."""
        from flow_sdk.builtin.agentic_process.cli_drivers.device_login import get_device_login_session
        from flow_sdk.request_context.methods import get_current_request_info

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else None
        code = str((body or {}).get("code", "")).strip()
        session_key = self._login_session_key()
        session = get_device_login_session(session_key) if session_key else None
        if not code or session is None or not session.submit_code(code):
            return ApiFailResponse(message="no login awaiting a code")
        return ApiSuccessResponse(data={"submitted": True})

    @action.post(action_name="device-login-cancel")
    async def device_login_cancel_action(self) -> ApiSuccessResponse:
        from flow_sdk.builtin.agentic_process.cli_drivers.device_login import get_device_login_session

        session_key = self._login_session_key()
        session = get_device_login_session(session_key) if session_key else None
        if session is not None:
            session.cancel()
        self._set_login_fields(state=None)
        await self.notify_updated()
        return ApiSuccessResponse(data={"cancelled": session is not None})

    @action.post(action_name="report-signed-out")
    async def report_signed_out_action(self, message: str = "") -> ApiSuccessResponse:
        """Record a sign-out the HARNESS ITSELF reported while answering a turn.

        The strongest evidence a harness is signed out is the harness saying so.
        Claude Code answers a signed-out turn with ``"Not logged in · Please run
        /login"`` (codex and copilot phrase theirs the same way), and
        ``tail_status_detail`` already lifts that sentence out of the transcript
        and ships it as ``worker_status_detail``. That is proof about THIS box at
        the moment of use — strictly better evidence than ``auth-status``, whose
        5s subprocess probe can time out or return output it cannot parse and
        then, by design, leaves ``login_state`` exactly as it was.

        Which is how the login modal came to open ON a "Not logged in" error and
        greet the user with "Signed in": the sentence opened the modal and was
        then thrown away, while a months-old ``AUTHENTICATED`` from the last
        successful device login stood unchallenged. An undetermined probe must
        not assert a sign-out — that is ``_mirror_probe_to_login_state``'s rule
        and it stays — but it must not preserve a positive claim in the face of
        the harness's own denial either. This is the writer for that denial.

        A login in flight is not clobbered (the same guard the probe mirror
        keeps): the user is mid-sign-in and the stale turn error is older than
        what they are doing right now.
        """
        if self.login_state in (DeviceLoginState.AWAITING_USER, DeviceLoginState.STARTING):
            return ApiSuccessResponse(data={"recorded": False, "reason": "login in flight"})
        self.login_state = DeviceLoginState.IDLE
        self.login_denied = True
        self.login_message = message.strip() or f"{self.kind} reported that it is not logged in."
        await self.notify_updated()
        return ApiSuccessResponse(data={"recorded": True})

    async def refresh_login_state(self):
        """Ask the vendor CLI whether it is signed in, and mirror the verdict.

        The one way to move ``login_state``, which is ``Persist.FALSE`` and so
        ``None`` — "nobody has asked" — after every restart. Bounded (the probe
        caps itself at five seconds and never raises) and local: no vendor
        probe makes a network call.

        Returns the full ``WorkerAuthResult`` so a caller can read what the
        vendor said beyond signed-in/out (claude reports an email and a
        subscription type); the mirror keeps only the verdict, deliberately.
        """
        from flow_sdk.builtin.agentic_process.cli_drivers import get_driver  # noqa: PLC0415

        worker_type = self._login_worker_type()
        if worker_type is None:
            return None
        result = await get_driver(worker_type).auth_probe()
        await self._mirror_probe_to_login_state(result)
        return result

    async def _mirror_probe_to_login_state(self, result) -> None:
        """Mirror an auth probe onto ``login_state`` — but only when the probe
        actually DECIDED.

        ``docs/interface/cli-drivers.md`` pins the driver contract: the probe
        distinguishes ``LOGGED_IN`` / ``LOGGED_OUT`` from ``NOT_INSTALLED`` (no
        discovered bin folder) and ``UNKNOWN`` (timeout, exec error, output it
        could not parse) — the last two "never conflated with ``LOGGED_OUT``".
        Collapsing all four into authenticated/idle broke exactly that: ``idle``
        is what ``isHarnessLoginRequired`` renders as "a coding agent CLI is
        installed but not signed in", so a probe that merely failed to reach a
        verdict told the user their signed-in harness was signed out.

        An undetermined probe is evidence about the PROBE, not about login, so
        it moves the field in neither direction — it does not assert a sign-out
        and does not clear a real one. The caller still receives the full
        result, so the modal can say what actually happened.
        """
        import logging

        if self.login_state in (DeviceLoginState.AWAITING_USER, DeviceLoginState.STARTING):
            return  # a login is in flight; don't clobber it

        if result.status is WorkerAuthStatus.LOGGED_IN:
            if self.login_denied and not result.verified:
                # The probe found a credential; the harness already told us that
                # credential does not work. Presence loses to a witnessed
                # refusal — otherwise the modal's own re-probe on open restores
                # the green "Signed in" it just corrected, and the footer follows
                # it. Only a completed login (``_apply_login_session``) or a
                # probe that actually VERIFIED the credential clears the denial.
                logging.getLogger(__name__).info(
                    "Auth probe for %s reports a stored credential, but %s already refused a turn "
                    "(%r) — keeping login_state=%r",
                    self.kind,
                    self.kind,
                    self.login_message,
                    self.login_state,
                )
                return
            new_state = DeviceLoginState.AUTHENTICATED
            self.login_denied = False
        elif result.status is WorkerAuthStatus.LOGGED_OUT:
            new_state = DeviceLoginState.IDLE
        else:
            logging.getLogger(__name__).info(
                "Auth probe for %s did not determine login state (%s: %s) — leaving login_state=%r",
                self.kind,
                result.status.value,
                result.message,
                self.login_state,
            )
            return
        # Cleared on a sign-out rather than left standing: an account line under
        # "Signed out" is the same lie as one under "Not checked".
        identity = result.identity if new_state is DeviceLoginState.AUTHENTICATED else ""
        plan = result.plan if new_state is DeviceLoginState.AUTHENTICATED else ""
        # Only broadcast when the mirror actually changes (a no-op probe
        # shouldn't emit a WS frame).
        if (
            new_state != self.login_state
            or result.message != self.login_message
            or identity != (self.login_identity or "")
            or plan != (self.login_plan or "")
        ):
            self.login_state = new_state
            self.login_message = result.message
            self.login_identity = identity
            self.login_plan = plan
            await self.notify_updated()

    @action.get(action_name="auth-status")
    async def auth_status_action(self, force: bool = False) -> ApiSuccessResponse | ApiFailResponse:
        """Cheap login-state probe (no version run) — the startup gate's check.

        Mirrors a DECIDED result onto ``login_state`` and broadcasts, so every
        surface agrees without waiting for a full test. A probe that could not
        reach a verdict leaves the field alone — see
        ``_mirror_probe_to_login_state``.

        ``force`` drops a recorded refusal first, and exists so the user is never
        stuck: the probe cannot overturn a refusal on its own (presence is not
        validity), which would otherwise leave a harness the user re-authorised
        OUTSIDE FlowPad — ``claude /login`` in their own terminal — reading as
        signed out with no way back. An explicit "Test" is the user saying they
        fixed it and asking us to look again; the silent re-probe the login modal
        runs on open is not, and passes nothing.
        """
        if force:
            self.login_denied = False
        worker_type = self._login_worker_type()
        if worker_type is None:
            runner = self._device_login_runner()
            if runner is None:
                return ApiFailResponse(message=f"capability {self.kind!r} has no worker auth")
            result = await runner.login_probe()
            await self._mirror_probe_to_login_state(result)
            return ApiSuccessResponse(data=result.to_json())
        from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import driver_api_auth_spec
        from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import WorkerAuthResult
        from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_box_llm_endpoint
        from flow_sdk.builtin.llm_endpoint import LLMEndpointKind

        spec = driver_api_auth_spec(worker_type)
        # Report what actually FUNDS this harness, not what a field says it prefers.
        # ``auth_mode`` is a preference now -- honoured while available -- so reading it here
        # would claim "using openrouter" for a harness whose key was deleted, and would miss a
        # hub endpoint the box was offered. ``resolve_box_llm_endpoint`` is the same resolver a
        # spawn uses, so this answer and that one cannot disagree.
        candidate = await resolve_box_llm_endpoint(worker_type) if spec is not None else None
        endpoint, source = candidate if candidate is not None else (None, None)

        # ALWAYS probe the vendor, whatever funds the harness today. This action and the
        # startup sweep (``discovery._resolve_login_states``) are the two producers of
        # ``login_state`` -- the sweep answers it for every box on boot, this answers it on
        # demand. The field is ``Persist.FALSE`` and therefore ``None`` after every restart,
        # and the resolver reads exactly that field to decide whether a device
        # login is proven. Probing only when device already won closes a loop with no exit: on a
        # box the hub has bound, the endpoint wins because device is unproven, so the probe never
        # runs, so device stays unproven forever -- and the user's "Test sign-in" button stops
        # asking precisely for the harnesses where the answer matters most.
        probe = await self.refresh_login_state()

        if source is not None and endpoint.kind != LLMEndpointKind.DEVICE:
            # Funded by a key or a hub endpoint: the vendor's own login state is real news about
            # the device rung, but it is not this harness's status. ``verified`` stays False --
            # the credential is present, not proven.
            result = WorkerAuthResult(
                status=WorkerAuthStatus.LOGGED_IN if source.eligible else WorkerAuthStatus.LOGGED_OUT,
                verified=False,
                auth_mode="api",
                message=source.reason or f"Using {source.name}",
                details={
                    # The ROW's provider, not the verdict's: ``LLMSource`` names an endpoint and
                    # mirrors none of its fields, so reading ``source.provider`` raised
                    # ``AttributeError`` and 500'd this action for every harness a key or a hub
                    # endpoint funds -- the exact harnesses whose device login most needs
                    # re-probing. A crash here froze ``login_state`` at whatever the last sweep
                    # saw, so a user who signed in afterwards stayed "signed out" on the
                    # LLM-sources screen with no way to pick their own login.
                    "provider": endpoint.provider,
                    "hub_endpoint": source.endpoint_typeid or None,
                    "llm_source": source.model_dump(mode="json"),
                    "device_login": probe.status.value,
                },
            )
        else:
            result = probe
            if source is not None:
                result.details = {**result.details, "llm_source": source.model_dump(mode="json")}
        # Surface the harness's supported API providers regardless of mode, so the
        # modal can offer the key section / provider select for any harness.
        if spec is not None:
            result.details = {
                **result.details,
                "supported_providers": [p.value for p in spec.supported_providers],
            }
        # No second mirror. ``refresh_login_state`` above already wrote the vendor's own
        # verdict, and ``result`` on the api path is NOT that verdict -- it is a synthesized
        # answer about the ENDPOINT (logged_in iff the endpoint is eligible). Mirroring it wrote
        # a judgement about a hub budget onto the field that means "is this device login signed
        # in", so a budget the box could not spend reported the user's perfectly good ``claude``
        # login as signed out -- and a signed-out device row offers "Sign in" where it should
        # offer "Use", the one control that switches funding back to OAuth.
        return ApiSuccessResponse(data=result.to_json())

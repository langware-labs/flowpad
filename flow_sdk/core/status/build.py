"""Build the status record. Pure reads: no probe, no network, no write.

Every fact has exactly one reader here, and every other module that needs the fact asks this
module (or the ``StatusSpec`` it returns) instead of answering it again. Refreshing a fact --
running discovery, probing a login -- is ``refresh.py``, an explicit action.
"""

from __future__ import annotations

import asyncio
import re

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import DeviceLoginState
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.flowpad_types.vendors import VENDORS, Vendor
from flow_sdk.schema.data_spec.status_spec import (
    AccountSpec,
    HarnessStatusSpec,
    HubLogin,
    HubStatusSpec,
    InstallState,
    KeyStatusSpec,
    LoginState,
    StatusSpec,
)

#: ``1.0.88``, ``2.1.288``, ``0.154.0-beta.1`` -- never a trailing dot from the sentence around it.
_VERSION = re.compile(r"\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?")


# ── installed ───────────────────────────────────────────────────────────────────


def harness_install(worker_type: str) -> InstallState:
    """THE answer to "is this harness's CLI on this machine".

    Disk-verified against the discovered bin folder (``worker_executable``): a CLI removed
    after discovery reads as not installed here rather than surfacing as a spawn error later.
    ``UNKNOWN`` only before the first discovery sweep has finished, the one window where an
    absent value is not yet an answer.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_executable,
    )
    from flow_sdk.core.capabilities.discovery import has_discovered  # noqa: PLC0415
    from flow_sdk.flowpad_types.vendors import vendor_or_none  # noqa: PLC0415

    if worker_executable(worker_type) is not None:
        vendor = vendor_or_none(worker_type)
        return InstallState.BUILT_IN if vendor is not None and vendor.python_module else InstallState.INSTALLED
    return InstallState.NOT_INSTALLED if has_discovered() else InstallState.UNKNOWN


def is_installed(worker_type: str) -> bool:
    """Whether a spawn of *worker_type* can find its CLI (installed or built in)."""
    return harness_install(worker_type) in (InstallState.INSTALLED, InstallState.BUILT_IN)


# ── login ───────────────────────────────────────────────────────────────────────


def login_state(install: InstallState, has_device_login: bool, cap) -> LoginState:
    """The ONE translation from the stored device-login fields to a ``LoginState``.

    No login exists for a CLI that is not here or for a harness with no account of its own.
    A login nobody has probed is NOT_CHECKED -- never presumed signed in. A sign-out the
    harness itself reported (``login_denied``) outranks a stored credential.
    """
    if install in (InstallState.NOT_INSTALLED, InstallState.UNKNOWN) or not has_device_login:
        return LoginState.N_A
    raw = getattr(cap, "login_state", None)
    state = getattr(raw, "value", raw) or ""
    if state == DeviceLoginState.AUTHENTICATED.value:
        return LoginState.SIGNED_OUT if getattr(cap, "login_denied", None) else LoginState.SIGNED_IN
    if state == DeviceLoginState.IDLE.value:
        return LoginState.SIGNED_OUT
    if state == DeviceLoginState.ERROR.value:
        return LoginState.ERROR
    if state in (DeviceLoginState.STARTING.value, DeviceLoginState.AWAITING_USER.value):
        return LoginState.SIGNING_IN
    return LoginState.NOT_CHECKED


def _version(cap) -> str:
    """The CLI's version, parsed from the ``--version`` output its last check recorded."""
    check = getattr(cap, "last_check", None) or {}
    output = str(((check.get("details") or {}) if isinstance(check, dict) else {}).get("output") or "")
    match = _VERSION.search(output)
    return match.group(0) if match else ""


async def _harness(vendor: Vendor) -> HarnessStatusSpec:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import driver_api_auth_spec  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_executable,
    )
    from flow_sdk.builtin.capability import Capability  # noqa: PLC0415
    from flow_sdk.core.capabilities.registry import get_capability_registry  # noqa: PLC0415

    auth = driver_api_auth_spec(vendor.key)
    has_device_login = bool(auth is None or auth.has_device_login)
    key_providers = tuple(p.value for p in (auth.supported_providers if auth else ()) if p is not LMApiProvider.FLOWPAD)
    try:
        spec = get_capability_registry().get(vendor.capability_kind).spec
    except KeyError:
        spec = None
    cap = await Capability.get_by_kind(vendor.capability_kind)
    install = harness_install(vendor.key)
    login = login_state(install, has_device_login, cap)
    signed_in = login is LoginState.SIGNED_IN
    return HarnessStatusSpec(
        kind=vendor.capability_kind,
        worker_type=vendor.key,
        label=vendor.label,
        icon=str(getattr(spec, "icon", "") or ""),
        install=install,
        version=_version(cap) if install is InstallState.INSTALLED else "",
        path=worker_executable(vendor.key) or "",
        login=login,
        login_checked_at=str(getattr(cap, "login_checked_at", "") or "") if login is not LoginState.N_A else "",
        login_message=str(getattr(cap, "login_message", "") or "") if login is not LoginState.N_A else "",
        account=AccountSpec(
            identity=str(getattr(cap, "login_identity", "") or "") if signed_in else "",
            plan=str(getattr(cap, "login_plan", "") or "") if signed_in else "",
        ),
        has_device_login=has_device_login,
        key_providers=key_providers,
        install_command=str(getattr(spec, "install_command", "") or ""),
        homepage_url=str(getattr(spec, "homepage_url", "") or ""),
    )


# ── keys ────────────────────────────────────────────────────────────────────────


def stored_key_providers() -> dict[str, str]:
    """THE answer to "which LLM-provider keys are stored": ``{provider: created_at}``.

    Names only -- ``get_secrets`` lists the shadow records and never opens the store, so
    nothing here decrypts a key or proves it works.
    """
    from flow_sdk.cli.auth.secrets import get_secrets  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import LM_SECRET_PREFIX  # noqa: PLC0415

    out: dict[str, str] = {}
    for record in get_secrets():
        name = str(record.get("name") or "")
        if name.startswith(LM_SECRET_PREFIX):
            out[name[len(LM_SECRET_PREFIX) :]] = str(record.get("created_at") or "")
    return out


def stored_key_hints() -> dict[str, str]:
    """``{provider: hint}`` for every stored LLM-provider key -- the masked ``****last4`` the shadow
    record carries, never the value. A key stored before hints existed maps to ``""``.
    """
    from flow_sdk.cli.auth.secrets import get_secrets  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import LM_SECRET_PREFIX  # noqa: PLC0415

    out: dict[str, str] = {}
    for record in get_secrets():
        name = str(record.get("name") or "")
        if name.startswith(LM_SECRET_PREFIX):
            out[name[len(LM_SECRET_PREFIX) :]] = str(record.get("hint") or "")
    return out


def _keys() -> tuple[KeyStatusSpec, ...]:
    stored = stored_key_providers()
    hints = stored_key_hints()
    providers = [p.value for p in LMApiProvider if p is not LMApiProvider.FLOWPAD]
    return tuple(
        KeyStatusSpec(provider=p, stored=p in stored, created_at=stored.get(p, ""), hint=hints.get(p, ""))
        for p in providers
    )


# ── hub ─────────────────────────────────────────────────────────────────────────


def hub_status() -> HubStatusSpec:
    """THE answer to "is this box signed in to FlowPad".

    Signed in means the hub ANSWERED: the authenticated hub socket verified the current
    user (``hub_ws_manager.verify_current_user``). A stored credential alone is not a
    sign-in -- it is ``OFFLINE`` until the hub confirms it, and ``REJECTED`` once it refuses.
    """
    from flow_sdk.cli.app_config import get_user  # noqa: PLC0415
    from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415
    from flow_sdk.cloud_client.auth_state import current_login_status  # noqa: PLC0415
    from flow_sdk.cloud_client.auth_status import HubConnectionStatus, HubLoginStatus  # noqa: PLC0415
    from flow_sdk.cloud_client.ws_client import hub_ws_manager  # noqa: PLC0415

    connection = hub_ws_manager.connection_payload()
    error = str(connection.get("error") or "")
    status = str(connection.get("status") or "")
    if current_login_status() is HubLoginStatus.LOGGING_IN:
        return HubStatusSpec(login=HubLogin.SIGNING_IN)
    if not hub_auth_available():
        return HubStatusSpec(login=HubLogin.SIGNED_OUT)
    if status == HubConnectionStatus.AUTH_REJECTED.value or current_login_status() is HubLoginStatus.LOGIN_FAILED:
        return HubStatusSpec(login=HubLogin.REJECTED, error=error)
    if hub_ws_manager.is_verified:
        user = get_user() or {}
        user_id = str(user.get("id") or "")
        return HubStatusSpec(
            login=HubLogin.SIGNED_IN,
            email=str(user.get("email") or ""),
            user_typeid=f"user-{user_id}" if user_id else "",
        )
    if status in (HubConnectionStatus.CONNECTING.value, HubConnectionStatus.CONNECTED.value):
        return HubStatusSpec(login=HubLogin.SIGNING_IN)
    return HubStatusSpec(login=HubLogin.OFFLINE, error=error)


# ── the record ──────────────────────────────────────────────────────────────────


async def default_harness_kind() -> str:
    """The capability kind of the user's default harness (a selection, not a probe)."""
    from flow_sdk.core.capabilities.models import CapabilityKind  # noqa: PLC0415
    from flow_sdk.core.capabilities.registry import CapabilityReferenceRunner, get_capability_registry  # noqa: PLC0415

    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)
    if not isinstance(runner, CapabilityReferenceRunner):
        return ""
    return await runner.resolve_reference_kind() or ""


async def build_status() -> StatusSpec:
    """The whole status record, read from the stores that own each fact."""
    harnesses = await asyncio.gather(*(_harness(v) for v in VENDORS))
    return StatusSpec(
        harnesses=tuple(harnesses),
        keys=_keys(),
        hub=hub_status(),
        default_harness=await default_harness_kind(),
    )

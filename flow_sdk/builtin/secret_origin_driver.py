"""SecretOrigin driver registry.

The driver is the behavior side of a secret pointer. The pointer itself remains
value-free and serializable; a driver may resolve (or store) a value only in a
runtime context such as worker launch or the setup wizard.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Iterable, Optional, Protocol, runtime_checkable

from pydantic import SecretStr

if TYPE_CHECKING:
    from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


_KIND_ALIASES = {
    "hub": "flowpad-hub",
    "flowpad_hub": "flowpad-hub",
}


class SecretProvideUnsupported(RuntimeError):
    """A driver whose value can't be cached locally yet (external provider slot)."""


def make_setup_hint(
    kind: str,
    *,
    sod_store: str,
    provider_label: str,
    prompt: str,
    coming_soon: bool = False,
    coord_fields: Iterable[str] = (),
) -> dict[str, Any]:
    """The value-free hint that drives the setup wizard (uniform shape).

    ``coord_fields`` names the provider coordinates the UI should ask for
    (``gcp`` wants three, ``local`` wants one). It is the ONLY thing the old
    per-kind field table was still needed for once identity stopped being
    locator-derived — so it lives here, once, instead of in four places.
    """
    hint: dict[str, Any] = {
        "kind": kind,
        "sod_store": sod_store,
        "provider_label": provider_label,
        "prompt": prompt,
        "coord_fields": list(coord_fields),
    }
    if coming_soon:
        hint["coming_soon"] = True
    return hint


@runtime_checkable
class SecretOriginDriver(Protocol):
    kind: str

    async def resolve(self, locator: "SecretOriginLocator", **context: Any) -> Optional[SecretStr]:
        ...

    async def can_resolve(self, locator: "SecretOriginLocator", **context: Any) -> bool:
        """True when ``resolve`` would return a value on this machine right now,
        WITHOUT fetching it — powers the resolve-status surface and decides whether
        the setup wizard is needed. Value-free by contract."""
        ...

    def setup_hint(self, locator: "SecretOriginLocator") -> dict[str, Any]:
        """Value-free hint that drives the setup wizard when a secret can't be
        resolved: ``{kind, sod_store, provider_label, prompt, coming_soon?}``."""
        ...

    async def store(self, locator: "SecretOriginLocator", value: str, **context: Any) -> None:
        """Cache a user-provided value in this driver's SOD store (the setup
        wizard's write path — symmetric with ``resolve``). Raise
        ``SecretProvideUnsupported`` for provider slots that can't cache yet."""
        ...


class ProviderStubDriver:
    """An external-provider slot: value-free pointer that can't resolve or cache
    locally yet, so it always routes to the setup wizard as 'coming soon'.
    Parametrized so gcp / 1password / … share one implementation."""

    def __init__(self, kind: str, coord_fields: Iterable[str], provider_label: str, prompt: str) -> None:
        self.kind = kind
        self.coord_fields = tuple(coord_fields)
        self._provider_label = provider_label
        self._prompt = prompt

    async def resolve(self, locator: "SecretOriginLocator", **context: Any) -> Optional[SecretStr]:
        return None

    async def can_resolve(self, locator: "SecretOriginLocator", **context: Any) -> bool:
        return False

    def setup_hint(self, locator: "SecretOriginLocator") -> dict[str, Any]:
        return make_setup_hint(
            self.kind, sod_store="sodot", provider_label=self._provider_label,
            prompt=self._prompt, coming_soon=True, coord_fields=self.coord_fields,
        )

    async def store(self, locator: "SecretOriginLocator", value: str, **context: Any) -> None:
        raise SecretProvideUnsupported(
            f"Providing values for '{self.kind}' secrets is coming soon — connect the provider."
        )


class SecretOriginDriverRegistry:
    def __init__(self) -> None:
        self._drivers: dict[str, SecretOriginDriver] = {}

    def register(self, driver: SecretOriginDriver) -> None:
        self._drivers[driver.kind] = driver

    def get(self, kind: str) -> SecretOriginDriver:
        name = normalize_secret_origin_kind(kind)
        try:
            return self._drivers[name]
        except KeyError as exc:
            raise KeyError(f"Unknown SecretOrigin kind: {kind!r}") from exc


def normalize_secret_origin_kind(kind: Any) -> str:
    key = str(kind or "").strip().lower()
    return _KIND_ALIASES.get(key, key)


def _build_default_registry() -> SecretOriginDriverRegistry:
    from flow_sdk.builtin.drivers.env_local_secret_driver import EnvLocalSecretDriver
    from flow_sdk.builtin.drivers.hub_secret_driver import HubSecretDriver
    from flow_sdk.builtin.drivers.local_secret_driver import LocalSecretDriver

    registry = SecretOriginDriverRegistry()
    registry.register(LocalSecretDriver())     # sodot (local encrypted store)
    registry.register(EnvLocalSecretDriver())  # project .env.local store
    registry.register(HubSecretDriver())       # the hub — the system of record
    # External provider slots — the pointer travels and materializes, but the
    # value stays with the provider, so they route to the setup wizard.
    registry.register(ProviderStubDriver(
        "gcp", ("gcp_project", "secret", "version"), "Google Secret Manager",
        "Connect Google Secret Manager, or paste the value to cache it locally.",
    ))
    registry.register(ProviderStubDriver(
        "1password", ("vault", "item", "field"), "1Password",
        "Connect 1Password, or paste the value to cache it locally.",
    ))
    return registry


_DEFAULT_REGISTRY: Optional[SecretOriginDriverRegistry] = None


def get_secret_origin_registry() -> SecretOriginDriverRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = _build_default_registry()
    return _DEFAULT_REGISTRY


def get_secret_origin_driver(kind: str) -> SecretOriginDriver:
    return get_secret_origin_registry().get(kind)

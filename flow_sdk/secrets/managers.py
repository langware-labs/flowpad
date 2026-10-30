"""Secret managers — a driver over a tool that holds vaults (``agentic-assets/secret_manager/<name>/``).

A manager is self-contained in its asset folder, the way a data driver is: ``secret_manager.json``
(the :class:`SecretManagerSpec` — title, config fields, and the CLI commands per OS) and ``store.py``
(the one ``SecretStore`` subclass, registered under the manager's name). Nothing here knows a
manager by name; it reads the folder and asks.

    spec = get_manager(vault.manager)
    store = store_for(vault)                      # a SecretStore over that one vault
    ready = await run_check(vault)                # the manager's ``check`` exits 0
    await run_grant(vault, "bob@acme.com")        # the manager's ``grant``
    cli_command(vault.manager, "login", "darwin")

Command templates name ``{vault}``, ``{email}`` and the vault's config keys. A command is split into
arguments BEFORE substitution and run without a shell, so a substituted value is one argument and
never shell syntax.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import shutil
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Optional, Union

from pydantic import Field

from flow_sdk.assets.python_module import load_package_module
from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.errors import SecretStoreError
from flow_sdk.secrets.store import SecretStore

logger = logging.getLogger(__name__)

SHIPPED_ROOT = Path(__file__).resolve().parents[1] / "system_projects" / "flowpad_assistant" / "agentic-assets" / "secret_manager"
MANIFEST_FILE = "secret_manager.json"
STORE_FILE = "store.py"
PACKAGE_PREFIX = "flowpad_secret_manager_"
OPS = ("install", "login", "check", "grant")
OSES = ("darwin", "linux", "win32")


class ConfigFieldSpec(DataSpec):
    """One field a vault of this manager is configured with."""

    name: str = Field(min_length=1)
    label: str = ""
    required: bool = False


class OsCommandsSpec(DataSpec):
    """One command per OS (``""``: none on that OS)."""

    darwin: str = ""
    linux: str = ""
    win32: str = ""


class SecretManagerSpec(AssetDocumentSpec):
    """``secret_manager.json`` — what a manager is and the commands that set it up."""

    name: str = Field(min_length=1)
    title: str = ""
    icon: str = ""
    description: str = ""
    config_fields: list[ConfigFieldSpec] = Field(default_factory=list)
    install: OsCommandsSpec = Field(default_factory=OsCommandsSpec)
    login: OsCommandsSpec = Field(default_factory=OsCommandsSpec)
    #: Exits 0 when this machine can read the vault.
    check: str = ""
    #: Gives ``{email}`` read access to the vault.
    grant: str = ""
    #: Environment for every command, filled like a command (``{"OP_ACCOUNT": "{account}"}``); a
    #: variable whose placeholder the vault's config does not fill is left out.
    env: dict[str, str] = Field(default_factory=dict)


class UnknownSecretManager(SecretStoreError, KeyError):
    code = "unknown_secret_manager"

    def __init__(self, name: str, known: list[str]) -> None:
        self.name = name
        SecretStoreError.__init__(self, f"no secret manager {name!r}; known: {', '.join(known) or 'none'}")

    def __str__(self) -> str:  # KeyError would repr the message
        return SecretStoreError.__str__(self)


class SecretManagerLoadError(SecretStoreError):
    code = "secret_manager_load"


# ── loading ────────────────────────────────────────────────────────────────


def read_manifest(folder: Path) -> SecretManagerSpec:
    try:
        spec = SecretManagerSpec.model_validate(json.loads((folder / MANIFEST_FILE).read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        raise SecretManagerLoadError(f"{folder / MANIFEST_FILE} is unreadable or invalid: {exc}") from exc
    if spec.name != folder.name:
        raise SecretManagerLoadError(f"{folder / MANIFEST_FILE} names {spec.name!r}; the folder is {folder.name!r}")
    return spec


def _load_store(folder: Path, name: str) -> type[SecretStore]:
    """Import the folder's ``store.py`` in its own content-addressed package; its class must register as ``name``."""
    from flow_sdk.ingest.driver_registry import content_hash  # noqa: PLC0415 — same hashing as data drivers
    from flow_sdk.secrets.store import _TYPES  # noqa: PLC0415

    if not (folder / STORE_FILE).is_file():
        raise SecretManagerLoadError(f"{folder} has no {STORE_FILE}")
    package = f"{PACKAGE_PREFIX}{name}_{content_hash(folder)[:8]}"
    try:
        module = load_package_module(folder, STORE_FILE[:-3], package)
    except Exception as exc:  # noqa: BLE001 — an asset's import error is a load error
        raise SecretManagerLoadError(f"{folder / STORE_FILE} failed to import: {type(exc).__name__}: {exc}") from exc
    cls = _TYPES.get(name)
    if cls is None or cls.__module__ != module.__name__:
        raise SecretManagerLoadError(f"{folder / STORE_FILE} must register a SecretStore with type_name {name!r}")
    return cls


@lru_cache(maxsize=1)
def _registry() -> dict[str, tuple[SecretManagerSpec, type[SecretStore]]]:
    found: dict[str, tuple[SecretManagerSpec, type[SecretStore]]] = {}
    if not SHIPPED_ROOT.is_dir():
        return found
    for folder in sorted(p for p in SHIPPED_ROOT.iterdir() if (p / MANIFEST_FILE).is_file()):
        try:
            spec = read_manifest(folder)
            found[spec.name] = (spec, _load_store(folder, spec.name))
        except SecretManagerLoadError as exc:
            logger.warning("[secrets] secret manager %s did not load: %s", folder.name, exc)
    return found


def load_managers() -> None:
    """Load every shipped manager (registers each store under its name). Idempotent."""
    _registry()


def list_managers() -> list[SecretManagerSpec]:
    return [spec for spec, _ in _registry().values()]


def get_manager(name: str) -> SecretManagerSpec:
    try:
        return _registry()[name][0]
    except KeyError:
        raise UnknownSecretManager(name, sorted(_registry())) from None


def store_class(name: str) -> type[SecretStore]:
    get_manager(name)
    return _registry()[name][1]


def store_for(vault: Any) -> SecretStore:
    """The ``SecretStore`` over one vault (a ``SecretVaultSpec`` or ``{manager, config}``)."""
    manager, config = _vault_parts(vault)
    store_class(manager)
    return SecretStore.from_ref({"type": manager, "config": config})


# ── commands ───────────────────────────────────────────────────────────────


def current_os() -> str:
    return "win32" if sys.platform.startswith("win") else ("darwin" if sys.platform == "darwin" else "linux")


def cli_command(manager: Union[str, SecretManagerSpec], op: str, os: Optional[str] = None, **values: Any) -> str:
    """The manager's ``op`` command for ``os`` (default: this one); placeholders named in ``values`` filled in."""
    spec = manager if isinstance(manager, SecretManagerSpec) else get_manager(manager)
    if op not in OPS:
        raise ValueError(f"unknown op {op!r}; one of {', '.join(OPS)}")
    os = os or current_os()
    if os not in OSES:
        raise ValueError(f"unknown os {os!r}; one of {', '.join(OSES)}")
    raw = getattr(spec, op)
    template = getattr(raw, os) if isinstance(raw, OsCommandsSpec) else raw
    return template.format_map(_Keep({k: str(v) for k, v in values.items()})) if values else template


def command_argv(template: str, values: Mapping[str, Any]) -> list[str]:
    """``template`` as argv: split first, then fill each argument — a value never becomes syntax."""
    filled = _Keep({k: str(v) for k, v in values.items()})
    return [arg.format_map(filled) for arg in shlex.split(template)]


async def run_check(vault: Any) -> bool:
    """True when the manager's ``check`` exits 0 for this vault on this machine."""
    manager, config = _vault_parts(vault)
    spec = get_manager(manager)
    code, _ = await _run(spec.check, {**config, "vault": _vault_name(vault, config)}, spec.env)
    return code == 0


async def run_grant(vault: Any, email: str) -> None:
    """Give ``email`` read access to the vault; raises ``SecretStoreError`` with the tool's last line."""
    manager, config = _vault_parts(vault)
    spec = get_manager(manager)
    code, err = await _run(spec.grant, {**config, "vault": _vault_name(vault, config), "email": email}, spec.env)
    if code != 0:
        raise SecretStoreError(f"{manager} grant failed: {err or 'no detail'}")


def command_env(env: Mapping[str, str], values: Mapping[str, Any]) -> dict[str, str]:
    """The manager's ``env`` filled from ``values``; a variable left empty or unfilled is dropped."""
    filled = {k: v.format_map(_Keep({n: str(x) for n, x in values.items()})) for k, v in env.items()}
    return {k: v for k, v in filled.items() if v and "{" not in v}


async def _run(template: str, values: Mapping[str, Any], env: Optional[Mapping[str, str]] = None) -> tuple[int, str]:
    """``(exit code, last stderr line)``; 127 when the tool is not installed. Stdout is never read."""
    if not template:
        return 1, "no command"
    argv = command_argv(template, values)
    if shutil.which(argv[0]) is None:
        return 127, f"{argv[0]} is not installed"
    proc = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, **command_env(env or {}, values)},
    )
    _, err = await proc.communicate()
    lines = err.decode(errors="replace").strip().splitlines()
    return proc.returncode or 0, (lines[-1] if lines else "")


class _Keep(dict):
    """``format_map`` that leaves an unknown placeholder as it is."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def _vault_parts(vault: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(vault, Mapping):
        return str(vault["manager"]), dict(vault.get("config") or {})
    return str(vault.manager), dict(vault.config or {})


def _vault_name(vault: Any, config: Mapping[str, Any]) -> str:
    return str(config.get("vault") or (vault.get("name", "") if isinstance(vault, Mapping) else getattr(vault, "name", "")) or "")


__all__ = [
    "ConfigFieldSpec", "OsCommandsSpec", "SecretManagerSpec", "SecretManagerLoadError", "UnknownSecretManager",
    "cli_command", "command_argv", "current_os", "get_manager", "list_managers", "load_managers", "run_check", "run_grant",
    "store_class", "store_for",
]

"""Browser drivers — the ways a session can drive a browser (``agentic-assets/browser_driver/<name>/``).

Self-contained in its asset folder: ``browser_driver.json`` (the :class:`BrowserDriverSpec`) and
``instructions.md``. Shipped folders only: a project chooses a driver, it never supplies one.
Nothing here knows a driver by name; it reads the folder and asks.

    spec = get("agent")
    supports("extension", "codex")               # False: the manifest names claude only
    attach_for("agent", "codex")                 # BrowserAttach.MCP_SERVER
    mcp_spec_for("chrome_debug")                 # the server a session gets, config filled in
    text = instructions_for("agent")             # what a session using it is told

A driver's CONFIG (browser app, profile, port) is this machine's: the manifest's ``defaults``
under what a person saved in the instance's preferences (:func:`read_config`).
"""
from __future__ import annotations

import json
import logging
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Optional

from flow_sdk.schema.data_spec.browser_driver_spec import (
    ANY_WORKER,
    BrowserAttach,
    BrowserDriverSpec,
    BrowserKindSpec,
    BrowserProbe,
    WorkerSetupSpec,
)
from flow_sdk.utils.templates import fill

logger = logging.getLogger(__name__)

SHIPPED_ROOT = Path(__file__).resolve().parents[1] / "system_projects" / "flowpad_assistant" / "agentic-assets" / "browser_driver"
#: The driver a session gets when nothing names another, or what was named cannot serve its worker.
DEFAULT = "agent"
#: A driver's saved config per machine: ``{<driver>: {<field>: <value>}}`` in the instance's preferences.
PREF_CONFIG = "preferences.browser.config"
#: A profile is a folder name of Flowpad's own — never a path, never a real user profile.
_PROFILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")


class BrowserConfigError(ValueError):
    """A config value the driver cannot take; the message names the field."""


@lru_cache(maxsize=1)
def _registry() -> dict[str, BrowserDriverSpec]:
    found: dict[str, BrowserDriverSpec] = {}
    if not SHIPPED_ROOT.is_dir():
        return found
    for folder in sorted(p for p in SHIPPED_ROOT.iterdir() if (p / BrowserDriverSpec.main_file).is_file()):
        try:
            spec = BrowserDriverSpec.model_validate(json.loads((folder / BrowserDriverSpec.main_file).read_text(encoding="utf-8")))
        except (OSError, ValueError) as exc:
            logger.warning("[browser] browser driver %s did not load: %s", folder.name, exc)
            continue
        if spec.name != folder.name:
            logger.warning("[browser] %s names %r; the folder is %r", folder, spec.name, folder.name)
            continue
        found[spec.name] = spec
    return found


def list_drivers() -> list[BrowserDriverSpec]:
    """Every shipped driver, the default first."""
    return sorted(_registry().values(), key=lambda spec: (spec.name != DEFAULT, spec.name))


def names() -> tuple[str, ...]:
    return tuple(spec.name for spec in list_drivers())


def get(name: str) -> BrowserDriverSpec | None:
    return _registry().get(name or "")


# ── workers ────────────────────────────────────────────────────────────────


def worker_setup(name: str, worker: str) -> Optional[WorkerSetupSpec]:
    """The driver's entry for ``worker`` (a vendor key): its own, else the ``*`` one, else None."""
    spec = get(name)
    if spec is None:
        return None
    return spec.workers.get(worker or "") or spec.workers.get(ANY_WORKER)


def attach_for(name: str, worker: str) -> Optional[BrowserAttach]:
    setup = worker_setup(name, worker)
    return setup.attach if setup is not None else None


def supports(name: str, worker: str, *, has_switch: bool = False) -> bool:
    """Whether a session of ``worker`` can use the driver. ``has_switch``: the worker has a browser
    switch of its own — what a ``harness_extension`` driver rides."""
    attach = attach_for(name, worker)
    if attach is None:
        return False
    if attach is BrowserAttach.HARNESS_EXTENSION:
        return has_switch
    return get(name).mcp is not None  # type: ignore[union-attr]


def uses_switch(name: str) -> bool:
    """The driver rides a worker's own browser switch for at least one worker."""
    spec = get(name)
    return spec is not None and any(w.attach is BrowserAttach.HARNESS_EXTENSION for w in spec.workers.values())


# ── config ─────────────────────────────────────────────────────────────────


def _saved() -> dict:
    from flow_sdk.preferences import read_instance_pref  # noqa: PLC0415

    saved = read_instance_pref(PREF_CONFIG, None)
    return dict(saved) if isinstance(saved, dict) else {}


def read_config(name: str) -> dict[str, str]:
    """The driver's config on this machine: its ``defaults`` under what a person saved."""
    spec = get(name)
    if spec is None:
        return {}
    own = _saved().get(name)
    saved = {k: str(v) for k, v in own.items() if k in spec.defaults} if isinstance(own, dict) else {}
    return {**spec.defaults, **saved}


def check_config(name: str, values: Mapping[str, Any]) -> dict[str, str]:
    """``values`` as the driver takes them. Raises :class:`BrowserConfigError` naming the field."""
    spec = get(name)
    if spec is None:
        raise BrowserConfigError(f"no browser driver named {name!r}")
    editable = {field.name for field in spec.config_fields}
    clean: dict[str, str] = {}
    for key, raw in values.items():
        value = str(raw if raw is not None else "").strip()
        if key not in editable:
            raise BrowserConfigError(f"{key}: {spec.title or name} has no such setting")
        if key == "app" and value and value not in spec.apps:
            raise BrowserConfigError(f"app: must be one of {', '.join(spec.apps)}")
        if key == "profile" and not _PROFILE.fullmatch(value):
            raise BrowserConfigError("profile: a short name of letters, digits, - and _ (a profile of Flowpad's own)")
        if key == "port" and value and not (value.isdigit() and 1024 <= int(value) <= 65535):
            raise BrowserConfigError("port: a number from 1024 to 65535")
        clean[key] = value
    return clean


def write_config(name: str, values: Mapping[str, Any]) -> dict[str, str]:
    """Save ``values`` over the driver's config on this machine; answers the config as it is now."""
    from flow_sdk.preferences import write_instance_pref  # noqa: PLC0415

    clean = check_config(name, values)
    saved = _saved()
    saved[name] = {**(saved.get(name) if isinstance(saved.get(name), dict) else {}), **clean}
    write_instance_pref(PREF_CONFIG, saved)
    return read_config(name)


# ── what a session gets ────────────────────────────────────────────────────


def mcp_spec_for(name: str):
    """The driver's MCP server for a session (``McpSpec``), its templates filled; None when it brings none."""
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec  # noqa: PLC0415

    spec = get(name)
    if spec is None or spec.mcp is None:
        return None
    values = {**read_config(name), "python": sys.executable, "driver": name}
    return McpSpec(name=spec.mcp.name, command=fill(spec.mcp.command, values), args=[fill(arg, values) for arg in spec.mcp.args])


def instructions_for(name: str) -> str:
    """The driver's own instructions for a session using it (its folder's ``instructions.md``); "" when none."""
    if get(name) is None:
        return ""
    try:
        return (SHIPPED_ROOT / name / "instructions.md").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _spellings(prefix: str) -> tuple[str, ...]:
    """A tool prefix as each worker writes it: ``mcp__<server>__`` and OpenCode's ``<server>_``."""
    server = re.fullmatch(r"mcp__(.+)__", prefix)
    return (prefix, f"{server.group(1)}_") if server else (prefix,)


def family_of(tool_name: str) -> str | None:
    """The driver whose tools ``tool_name`` belongs to (by its ``tool_prefixes``), or None."""
    return next(
        (spec.name for spec in list_drivers() for prefix in spec.tool_prefixes if tool_name.startswith(_spellings(prefix))),
        None,
    )


# ── state ──────────────────────────────────────────────────────────────────


def window_state(name: str) -> str:
    """A managed driver's window, whoever asks: ``running``, ``ready`` (it can start) or
    ``not_installed``. One port probe; starts nothing."""
    from flow_sdk.core import agent_browser  # noqa: PLC0415

    if agent_browser.status(driver=name).up:
        return "running"
    return "ready" if agent_browser.executable_for(name) else "not_installed"


def state_of(
    name: str, worker: str, *, has_switch: bool = False, extension_installed: bool = False,
    in_use: bool = False, last_use: Optional[Mapping[str, Any]] = None, window: str = "",
) -> str:
    """One word for a menu, read without starting anything: ``unsupported`` (this worker cannot use
    it), ``not_installed``, ``ready`` / ``running`` (a managed window), ``connected`` /
    ``not_connected`` (a worker-owned browser — proven only by a session's own call).
    ``window``: :func:`window_state` when the caller already read it (it is the same for every worker)."""
    spec = get(name)
    if spec is None or not supports(name, worker, has_switch=has_switch):
        return "unsupported"
    if spec.probe is BrowserProbe.EXTENSION:
        drove = bool(last_use) and last_use.get("family") == name  # type: ignore[union-attr]
        failed = bool(last_use and last_use.get("failed"))
        if drove and not failed:
            return "connected"
        if not extension_installed:
            return "not_installed"
        return "connected" if in_use and not failed else "not_connected"
    return window or window_state(name)


# ── kinds ──────────────────────────────────────────────────────────────────


def list_kinds(states: Mapping[str, str], scan: Any = None) -> list[BrowserKindSpec]:
    """Every browser a session could be given on this machine, one per profile: the list a person
    sees in the footer menu and an agent reads with ``flow browser list``.

    A driver that rides the worker's extension gives one entry per real browser profile
    (``scan``: :func:`browser_profiles.scan_extension`); a managed driver gives its own window,
    on the profile of Flowpad's it is configured with. ``states``: each driver's
    :func:`state_of`, read once by the caller."""
    from flow_sdk.core import agent_browser  # noqa: PLC0415
    from flow_sdk.core.browser_profiles import folder_times  # noqa: PLC0415

    kinds: list[BrowserKindSpec] = []
    for spec in list_drivers():
        state = states.get(spec.name, "")
        common = {"driving": spec.probe, "driver": spec.name, "icon": spec.icon, "install_url": spec.install_url}
        if spec.probe is BrowserProbe.EXTENSION:
            for found in scan.profiles if scan is not None else ():
                profile = found.profile
                kinds.append(BrowserKindSpec(
                    browser=found.browser_id, profile=profile.id, name=profile.name,
                    state=state if found.installed or state == "unsupported" else "not_installed",
                    created=profile.created, last_used=profile.last_used, **common,
                ))
            continue
        folder = agent_browser.profile_dir(spec.name)
        # Qualified by the driver: two managed drivers on "default" are two folders.
        kinds.append(BrowserKindSpec(
            browser=agent_browser.app_for(spec.name), profile=f"{spec.name}-{read_config(spec.name).get('profile') or 'default'}",
            name=spec.title or spec.name, state=state, **folder_times(folder, folder / "Default" / "History"), **common,
        ))
    return kinds

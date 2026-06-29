"""Toplog — topic-based runtime logging.

A lightweight debug-logging tool keyed by freeform *topics* (keywords). Sprinkle
``toplog.log([topics], msg)`` lines through the code; they stay silent until one
of their topics is turned on. Topics can be flipped on/off at runtime — from the
backend (this module) or the frontend (which round-trips through the REST route)
— without a restart.

The single source of truth is the per-instance file
``~/.flow/instances/<name>/toplog.json``::

    {"enabled": true, "filter": {"pty": true, "sync": true}}

* ``enabled`` — master switch. When false, every ``log()`` is a no-op.
* ``filter``  — topic→bool. A topic is *on* when present and truthy. Everything
  is off by default (empty filter).

Design (see toplog.md):

* The **file is authority.** In-memory ``_active_topics`` / ``_enabled`` are
  always *derived* from the file via :func:`_apply_from_file`. ``log()`` is a
  cheap in-memory guard — no file read on the hot path.
* The mutators (:func:`on` / :func:`off` / :func:`enable` / :func:`disable`)
  are **plain sync**: read-modify-**merge**-write the JSON, then re-derive the
  local in-memory state. They never touch the event loop or the WS broadcast.
* Broadcasting to other processes / the frontend is done by the FSOp trigger
  callback (``builtin_toplog_filter_apply``), the single broadcaster, which runs
  in the server's async context. Every writer converges through the file.

Multi-process note: :func:`_apply_from_file` runs once at import, so worker
processes honor the filter as it was at spawn time. Live re-toggling inside an
already-running worker is out of scope — only the main backend process (which
runs the FSOp watcher) picks up live changes.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Iterable, Union

_logger = logging.getLogger("toplog")

# In-memory state — ALWAYS derived from the file via _apply_from_file().
_active_topics: set[str] = set()
_enabled: bool = False

Topics = Union[str, Iterable[str]]


# ── helpers ──────────────────────────────────────────────────────────────────


def _normalize(topics: Topics) -> list[str]:
    """Accept a single topic string or any iterable of topic strings."""
    if isinstance(topics, str):
        return [topics]
    return [str(t) for t in topics]


def _config_path() -> Path:
    # Lazy import so this module stays a leaf (importable in CLI/tests without
    # pulling the server in) and so test fixtures that monkeypatch
    # get_instance_settings() get the redirected path.
    from flow_sdk.instance_settings import get_instance_settings

    return get_instance_settings().toplog_config_path


def _read_file() -> dict[str, Any]:
    """Tolerant read of toplog.json. Returns ``{}`` on missing/corrupt file."""
    try:
        path = _config_path()
        if not path.exists():
            return {}
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _apply_from_file(config: dict[str, Any] | None = None) -> None:
    """Re-derive the in-memory state (``_active_topics`` / ``_enabled``) from the
    authoritative JSON. The single place that mutates module state. Called at
    import, by the mutators, and by the FSOp trigger callback. Pass ``config`` to
    re-derive from an already-loaded dict (the mutators do, to avoid re-reading
    the file they just wrote)."""
    global _enabled
    if config is None:
        config = _read_file()
    flt = config.get("filter") or {}
    if isinstance(flt, dict):
        active = {str(k) for k, v in flt.items() if v}
    else:
        active = set()
    _active_topics.clear()
    _active_topics.update(active)
    _enabled = bool(config.get("enabled", False))


def _merge_write(mutate: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """Read-modify-write the JSON, MERGING (never whole-blob clobber).

    Reads the current file (tolerant), normalizes the ``enabled``/``filter``
    shape, applies ``mutate`` in place, writes it back, and returns the written
    config so the caller can re-derive state without a second read.
    """
    config = _read_file()
    if "enabled" not in config:
        config["enabled"] = False
    flt = config.get("filter")
    if not isinstance(flt, dict):
        flt = {}
    config["filter"] = flt
    mutate(config)
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config) + "\n", encoding="utf-8")
    return config


# ── public API ───────────────────────────────────────────────────────────────


def log(topics: Topics, msg: object, *args: Any, level: int = logging.INFO, **kwargs: Any) -> None:
    """Emit ``msg`` under ``logging.getLogger("toplog")`` iff the master switch is
    on AND at least one of ``topics`` is active (OR semantics). Cheap no-op
    otherwise. ``args``/``kwargs`` pass through to the standard logging call
    (``%``-style formatting), and the active topic(s) are prefixed.
    """
    if not _enabled:
        return
    matched = [t for t in _normalize(topics) if t in _active_topics]
    if not matched:
        return
    _logger.log(level, "[%s] " + str(msg), ",".join(matched), *args, **kwargs)


def is_on(topics: Topics) -> bool:
    """True iff the master switch is on AND any of ``topics`` is active."""
    if not _enabled:
        return False
    return any(t in _active_topics for t in _normalize(topics))


def is_enabled() -> bool:
    """The master switch (file-derived)."""
    return _enabled


def active_topics() -> set[str]:
    """Snapshot of the currently-active topics (file-derived)."""
    return set(_active_topics)


def state() -> dict[str, Any]:
    """The current state as broadcast/serialized: ``{enabled, filter}``."""
    return {"enabled": _enabled, "filter": {t: True for t in sorted(_active_topics)}}


def _mutate(mutate: Callable[[dict[str, Any]], None]) -> None:
    """Merge-write the file then re-derive local state from what was written —
    the shared body of every sync mutator. Synchronous and event-loop-free;
    broadcasting is the FSOp trigger callback's job."""
    _apply_from_file(_merge_write(mutate))


def on(*topics: str) -> None:
    """Turn ``topics`` on."""
    _mutate(lambda cfg: cfg["filter"].update({str(t): True for t in topics}))


def off(*topics: str) -> None:
    """Turn ``topics`` off (removes the keys)."""
    def _mut(cfg: dict[str, Any]) -> None:
        for t in topics:
            cfg["filter"].pop(str(t), None)

    _mutate(_mut)


def enable() -> None:
    """Flip the master switch on."""
    _mutate(lambda cfg: cfg.__setitem__("enabled", True))


def disable() -> None:
    """Flip the master switch off."""
    _mutate(lambda cfg: cfg.__setitem__("enabled", False))


def seed_file(enabled: bool) -> None:
    """Create toplog.json with the given master-switch default if it's absent,
    then apply. Boot hook for the server: toplog.py owns the on-disk schema, so
    the seed routes through ``_merge_write`` rather than hand-building the JSON."""
    if not _config_path().exists():
        _merge_write(lambda cfg: cfg.__setitem__("enabled", enabled))
    _apply_from_file()


# Seed the in-memory state from the file once at import. Safe everywhere: returns
# the off/empty default when the file is missing or get_instance_settings() is
# unavailable.
try:
    _apply_from_file()
except Exception:  # pragma: no cover — never let import fail
    pass

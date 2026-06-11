"""Single source of truth for backend logging configuration and correlation.

This module owns two debuggability concerns (logging roadmap, Phase 0 + 1):

* **Phase 0 — one config.** ``configure_logging()`` installs exactly one root
  handler + formatter, idempotently. It replaces the duplicate, conflicting
  ``logging.basicConfig`` calls that used to live in ``config.py`` and
  ``server/app.py``.

* **Phase 1 — correlation on every line.** ``CorrelationFilter`` injects the
  active request's context (instance, request counter, user, action, target
  entity) onto *every* stdlib log record — uvicorn, ``flow_sdk.*`` module
  loggers, everything — with zero changes at call sites. The fields are read
  lazily from the per-request ``RequestInfo`` at emit time, plus an explicit
  ``contextvars`` overlay used by non-request contexts (workers).

Deliberately dependency-light: this module must NOT import ``flow_sdk.config``
or ``flow_sdk.request_context`` at module load — ``config.py`` imports *this*
during its own initialization, so any heavy import here would be circular.
All such imports are done lazily inside functions and guarded.
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator

# Explicit correlation overlay for contexts without a RequestInfo (e.g. spawned
# workers). Values set here win over RequestInfo-derived fields of the same key.
_correlation_overlay: ContextVar[dict[str, str]] = ContextVar("_correlation_overlay", default={})

# Instance name is constant per process — resolve once, lazily, and cache.
_instance_name: str | None = None

# Marker so configure_logging() never double-installs its handler.
_CONFIGURED_ATTR = "_flowpad_root_handler"

_DEFAULT_FORMAT = "%(asctime)s [%(levelname)s]%(corr)s %(name)s: %(message)s"


def _resolve_instance_name() -> str:
    global _instance_name
    if _instance_name is not None:
        return _instance_name
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        _instance_name = get_instance_settings().instance_name
    except Exception:
        _instance_name = os.getenv("FLOW_INSTANCE") or "prod"
    return _instance_name


def set_correlation(**fields: Any) -> None:
    """Merge explicit correlation fields into the current context (overlay).

    Used by non-request code paths (e.g. workers) to stamp a ``trace`` id or
    other identifiers onto every log line they emit. ``None`` values are
    dropped so callers can pass-through optional ids without clearing.
    """
    merged = dict(_correlation_overlay.get())
    for key, value in fields.items():
        if value is None:
            continue
        merged[key] = str(value)
    _correlation_overlay.set(merged)


@contextmanager
def bind_correlation(**fields: Any) -> Iterator[None]:
    """Scope correlation fields to a ``with`` block, restoring on exit."""
    token = _correlation_overlay.set({**_correlation_overlay.get(), **{k: str(v) for k, v in fields.items() if v is not None}})
    try:
        yield
    finally:
        _correlation_overlay.reset(token)


def current_correlation() -> dict[str, str]:
    """Build the active correlation field map (cheap, never raises).

    Precedence (low → high): RequestInfo-derived fields, then the cross-process
    ``FLOWPAD_TRACE_ID`` env var, then the explicit overlay set via
    ``set_correlation``/``bind_correlation``.
    """
    fields: dict[str, str] = {"inst": _resolve_instance_name()}

    # RequestInfo-derived fields — read lazily so this module stays import-light.
    try:
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        info = get_current_request_info()
    except Exception:
        info = None

    if info is not None:
        try:
            fields["req"] = str(info.instance_counter)
            if info.action:
                fields["act"] = str(info.action)
            if info.target_entity_typeid:
                fields["ent"] = str(info.target_entity_typeid)
            user = getattr(info, "user", None)
            user_tid = getattr(user, "typeid", None) if user is not None else None
            if user_tid is not None:
                fields["user"] = str(user_tid)
            if info.request_connection_id:
                fields["conn"] = str(info.request_connection_id)
            # Renderer-minted trace id (X-Trace-Id header / WS trace_id field).
            if getattr(info, "trace_id", None):
                fields["trace"] = str(info.trace_id)
        except Exception:
            pass

    # Cross-process trace id for non-request contexts (e.g. workers) — inherited
    # via env. The request-scoped trace_id above takes precedence when present.
    env_trace = os.getenv("FLOWPAD_TRACE_ID")
    if env_trace and "trace" not in fields:
        fields["trace"] = env_trace

    overlay = _correlation_overlay.get()
    if overlay:
        fields.update(overlay)

    return fields


def format_correlation() -> str:
    """Render correlation as a bracketed suffix, or ``""`` when only the
    instance is known and nothing identifies the work.

    Returns a string with a *leading space* so it can be concatenated directly
    into a format string without leaving a gap when empty.
    """
    fields = current_correlation()
    # Don't emit a bracket for just the instance name — too noisy on every line
    # during boot before any request exists.
    if set(fields) <= {"inst"}:
        return ""
    parts = " ".join(f"{k}={v}" for k, v in fields.items())
    return f" [{parts}]"


class CorrelationFilter(logging.Filter):
    """Attach ``record.corr`` to every record (always passes the record)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.corr = format_correlation()
        except Exception:
            record.corr = ""
        return True


def make_formatter(fmt: str = _DEFAULT_FORMAT) -> logging.Formatter:
    return logging.Formatter(fmt)


def _resolve_level() -> int:
    level_str = os.getenv("LOG_LEVEL", "").upper()
    level = getattr(logging, level_str, None) if level_str else None
    return level if isinstance(level, int) else logging.INFO


def configure_logging() -> None:
    """Install the single root handler + correlation filter (idempotent).

    Safe to call from multiple entry points and on reloader restarts — a marker
    attribute guards against installing a second handler.
    """
    root = logging.getLogger()
    root.setLevel(_resolve_level())

    if any(getattr(h, _CONFIGURED_ATTR, False) for h in root.handlers):
        return

    # Own the root: drop any handler installed before us (e.g. the default one
    # Python auto-adds when something calls logging.info() before this runs).
    # Our later additions — the dev file mirror, the monitor handler — carry
    # their own marker attributes and are added after this, so they survive.
    for stale in list(root.handlers):
        root.removeHandler(stale)

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(make_formatter())
    handler.addFilter(CorrelationFilter())
    setattr(handler, _CONFIGURED_ATTR, True)
    root.addHandler(handler)

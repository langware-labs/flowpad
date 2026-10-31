"""The app's learned handlings (``setup/webapp_handlings.json``): matched by code, before any agent runs.

Match order: the app's own file, then the handlings Flowpad ships (``default_handlings.json``), then the
built-in ones. First match wins. A handling is added only through ``add``, which refuses one that does not
match the failure it was learned from — so a handling that can never fire is never written. A file that
cannot be read is a failure of its own (``HandlingFileError``), never silently "no handlings".
"""

from __future__ import annotations

import json
import logging
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.webapp_lifecycle_spec import (
    FailureCode,
    HandlingAction,
    WebappFailureSpec,
    WebappHandlingSpec,
    WebappHandlingsFile,
)

logger = logging.getLogger(__name__)

SETUP_DIR = "setup"
HANDLINGS_FILE = "webapp_handlings.json"
#: The rules file this one replaced; read once and converted (``migrate``).
LEGACY_FILE = "webapp_errors.json"
RECOVERY_FILE = "recovery.md"
LOG_FILE = "logs/errors.jsonl"

#: Every app has these, after its own and the shipped ones.
BUILTIN = [
    WebappHandlingSpec(id="builtin:not-answering", code=FailureCode.NOT_ANSWERING, action=HandlingAction.RESTART,
                       note="The server behind the page stopped answering: start it again."),
]


class HandlingFileError(ValueError):
    """``setup/webapp_handlings.json`` cannot be read — said, never read as an empty list."""


def setup_dir(folder: str | Path) -> Path:
    return Path(folder) / SETUP_DIR


def file_of(folder: str | Path) -> Path:
    return setup_dir(folder) / HANDLINGS_FILE


@lru_cache(maxsize=1)
def shipped() -> tuple[WebappHandlingSpec, ...]:
    data = json.loads((Path(__file__).parent / "default_handlings.json").read_text())
    return tuple(WebappHandlingsFile.model_validate(data).handlings)


def load(folder: str | Path) -> list[WebappHandlingSpec]:
    """The app's own handlings; [] when it has none. Raises ``HandlingFileError`` on a file that does not parse
    or holds an entry that does not validate — every entry, so one bad key never drops the others silently."""
    migrate(folder)
    path = file_of(folder)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text())
        return list(WebappHandlingsFile.model_validate(data).handlings)
    except (ValueError, TypeError) as exc:
        raise HandlingFileError(f"{path} cannot be read: {exc}") from exc


def matches(handling: WebappHandlingSpec, failure: WebappFailureSpec) -> bool:
    if handling.phase is not None and handling.phase != failure.phase:
        return False
    if handling.code is not None and handling.code != failure.code:
        return False
    if handling.source and handling.source != failure.source:
        return False
    if handling.fingerprint:
        return handling.fingerprint == failure.fingerprint
    if handling.pattern:
        try:
            return re.search(handling.pattern, failure.text) is not None or (
                bool(failure.raw) and re.search(handling.pattern, failure.raw) is not None)
        except re.error:
            return False
    # Neither: matched by phase/code/source alone (a built-in).
    return handling.phase is not None or handling.code is not None


def match(failure: WebappFailureSpec, own: list[WebappHandlingSpec]) -> Optional[WebappHandlingSpec]:
    """The first handling that knows this failure: the app's, then the shipped ones, then the built-ins."""
    return next((h for h in (*own, *shipped(), *BUILTIN) if matches(h, failure)), None)


def _save(folder: str | Path, handlings: list[WebappHandlingSpec]) -> None:
    from flow_sdk.instances.atomic import locked, write_json_atomic  # noqa: PLC0415

    path = file_of(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = WebappHandlingsFile(handlings=handlings).model_dump(mode="json", exclude_defaults=False)
    with locked(path.parent / ".webapp_handlings.lock"):
        write_json_atomic(path, body)


def add(folder: str | Path, handling: WebappHandlingSpec, *, proof: WebappFailureSpec) -> WebappHandlingSpec:
    """Add (or replace, by id) a handling learned from ``proof``. Refused unless it matches ``proof``."""
    if not handling.fingerprint and not handling.pattern:
        handling = handling.model_copy(update={"fingerprint": proof.fingerprint})
    if handling.pattern:
        try:
            re.compile(handling.pattern)
        except re.error as exc:
            raise ValueError(f"handling {handling.id}: its pattern is not a regex: {exc}") from exc
    if not matches(handling, proof):
        raise ValueError(f"handling {handling.id} does not match the failure it was learned from "
                         f"({proof.phase.value}/{proof.code.value}: {proof.text!r})")
    if not handling.learned_at:
        handling = handling.model_copy(update={"learned_at": time.strftime("%Y-%m-%d")})
    own = [h for h in load(folder) if h.id != handling.id]
    _save(folder, [*own, handling])
    return handling


def count(folder: str | Path, handling_id: str, *, fixed: bool) -> None:
    """The handling ran; the re-check held (``fixed``) or not. Built-in and shipped ones are not counted."""
    if not handling_id or handling_id.startswith(("builtin:", "default:")):
        return
    try:
        own = load(folder)
    except HandlingFileError:
        return
    if not any(h.id == handling_id for h in own):
        return
    key = "fixed" if fixed else "not_fixed"
    _save(folder, [h.model_copy(update={key: getattr(h, key) + 1}) if h.id == handling_id else h for h in own])


def set_action(folder: str | Path, handling_id: str, action: str) -> bool:
    """Turn one of the app's handlings to another action; False when there is no such handling or action."""
    try:
        chosen = HandlingAction(action)
        own = load(folder)
    except (ValueError, HandlingFileError):
        return False
    if not any(h.id == handling_id for h in own):
        return False
    _save(folder, [h.model_copy(update={"action": chosen}) if h.id == handling_id else h for h in own])
    return True


def log(folder: str | Path, failure: WebappFailureSpec, action: str, outcome: str, handling_id: str = "") -> None:
    """One line of the app's failure log (``setup/logs/errors.jsonl`` — instance-local, gitignored)."""
    path = setup_dir(folder) / LOG_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as out:
            out.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "phase": failure.phase.value,
                                  "code": failure.code.value, "source": failure.source, "text": failure.text[:2000],
                                  "fingerprint": failure.fingerprint, "handling": handling_id or None,
                                  "action": action, "outcome": outcome}) + "\n")
    except OSError as exc:
        logger.debug("failure log of %s not written: %s", folder, exc)


def recent(folder: str | Path, limit: int = 50) -> list[dict]:
    """The last ``limit`` lines of the app's failure log, newest first."""
    from collections import deque  # noqa: PLC0415

    path = setup_dir(folder) / LOG_FILE
    if not path.is_file():
        return []
    rows = []
    with path.open() as lines:
        for line in deque(lines, maxlen=limit):
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows[::-1]


def migrate(folder: str | Path) -> bool:
    """Convert a ``setup/webapp_errors.json`` (the regex rules before handlings) once: ``ignore`` stays
    ignore, a ``restart`` fix becomes RESTART, any other ``recover`` becomes ESCALATE with its fix as the
    agent's hint. The old file is removed. True when it converted one."""
    base = setup_dir(folder)
    legacy, path = base / LEGACY_FILE, base / HANDLINGS_FILE
    if not legacy.is_file() or path.is_file():
        return False
    try:
        rows = json.loads(legacy.read_text())
    except ValueError as exc:
        logger.warning("%s cannot be read, left as it is: %s", legacy, exc)
        return False
    out = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not row.get("pattern"):
            continue
        fix = str(row.get("fix") or "")
        action = (HandlingAction.IGNORE if row.get("action") == "ignore" else
                  HandlingAction.RESTART if fix.strip().lower() == "restart" else HandlingAction.ESCALATE)
        source = str(row.get("source") or "")
        out.append(WebappHandlingSpec(
            id=str(row.get("id") or f"rule-{len(out) + 1}"), pattern=str(row["pattern"]),
            source=source if source in ("page", "console", "network", "relay") else "",
            action=action, arg="" if action is not HandlingAction.ESCALATE else fix,
            learned_at=str(row.get("learned_at") or ""), note=fix if action is not HandlingAction.ESCALATE else ""))
    _save(folder, out)
    legacy.unlink()
    logger.info("converted %s to %s (%d handlings)", legacy, path, len(out))
    return True


__all__ = ["BUILTIN", "HandlingFileError", "add", "count", "file_of", "load", "log", "match", "matches", "migrate",
           "recent", "set_action", "shipped"]

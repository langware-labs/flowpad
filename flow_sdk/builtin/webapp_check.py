"""A webapp's page errors, decided: ``setup/webapp_errors.json`` turns each error into ignore or recover.

The viewer reports what the page threw while it loaded (``service_endpoint/<id>/page-report``). Each error is
matched against the app's rules, first match wins; an error no rule knows is ``recover`` — the agent
looks at it and, when it learns what it is, adds a rule so the next one is decided at once. Every
decision is appended to ``setup/logs/errors.jsonl``, the app's error log.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.webapp_spec import WebappErrorRule

logger = logging.getLogger(__name__)

SETUP_DIR = "setup"
ERRORS_FILE = "webapp_errors.json"
RECOVERY_FILE = "recovery.md"
ERROR_LOG = "logs/errors.jsonl"
LAST_CHECK = "logs/last_check.json"


@dataclass(frozen=True)
class PageError:
    """One thing the page reported: its text and where it came from (``page``, ``console``, ``network``)."""

    text: str
    source: str = "page"


@dataclass(frozen=True)
class Decision:
    error: PageError
    action: str  # "ignore" | "recover"
    rule: Optional[WebappErrorRule] = None


@dataclass(frozen=True)
class Verdict:
    """The page's answer: usable when nothing needs recovery."""

    decisions: list[Decision] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        return all(d.action == "ignore" for d in self.decisions)

    @property
    def to_recover(self) -> list[Decision]:
        return [d for d in self.decisions if d.action == "recover"]


def setup_dir(app_folder: str | Path) -> Path:
    return Path(app_folder) / SETUP_DIR


def load_rules(app_folder: str | Path) -> list[WebappErrorRule]:
    """The app's rules; none when the file is absent. A bad file is logged and read as no rules."""
    path = setup_dir(app_folder) / ERRORS_FILE
    if not path.is_file():
        return []
    try:
        return [WebappErrorRule.model_validate(row) for row in json.loads(path.read_text())]
    except (ValueError, TypeError) as exc:
        logger.warning("unreadable %s: %s", path, exc)
        return []


def _matches(rule: WebappErrorRule, error: PageError) -> bool:
    if rule.source and rule.source != error.source:
        return False
    try:
        return re.search(rule.pattern, error.text) is not None
    except re.error:
        return False


#: Rules every app has, after its own: a server that does not answer is restarted, with no agent.
BUILTIN_RULES = [
    WebappErrorRule(id="builtin:not-answering", type="not_answering", source="relay",
                    pattern=r"^not_answering$", action="recover", fix="restart"),
]


def triage(errors: list[PageError], rules: list[WebappErrorRule]) -> Verdict:
    """Each error against the app's rules, then the built-in ones; first match wins; unknown → ``recover``."""
    decisions = []
    every = [*rules, *BUILTIN_RULES]
    for error in errors:
        rule = next((r for r in every if _matches(r, error)), None)
        decisions.append(Decision(error=error, action=rule.action if rule else "recover", rule=rule))
    return Verdict(decisions)


def record(app_folder: str | Path, verdict: Verdict, outcome: str, rules: Optional[list] = None) -> None:
    """Note the check's outcome, append each decision to the app's error log, count each matched rule as seen.
    ``rules``: the app's rules as ``triage`` was given them (read again when not passed)."""
    from flow_sdk.instances.atomic import write_json_atomic  # noqa: PLC0415

    base = setup_dir(app_folder)
    write_json_atomic(base / LAST_CHECK, {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "usable": verdict.usable,
                                          "outcome": outcome, "errors": len(verdict.decisions)})
    if not verdict.decisions:
        return
    log = base / ERROR_LOG
    log.parent.mkdir(parents=True, exist_ok=True)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    with log.open("a") as out:
        for d in verdict.decisions:
            out.write(json.dumps({"at": now, "source": d.error.source, "text": d.error.text[:2000],
                                  "rule": d.rule.id if d.rule else None, "action": d.action,
                                  "outcome": outcome}) + "\n")
    seen = {d.rule.id for d in verdict.decisions if d.rule and not d.rule.id.startswith("builtin:")}
    if seen:
        rules = load_rules(app_folder) if rules is None else rules
        bumped = [r.model_copy(update={"seen": r.seen + 1}) if r.id in seen else r for r in rules]
        (base / ERRORS_FILE).write_text(json.dumps([r.model_dump() for r in bumped], indent=2) + "\n")


def recent_errors(app_folder: str | Path, limit: int = 50) -> list[dict]:
    """The last ``limit`` entries of the app's error log, newest first — read from its tail."""
    from collections import deque  # noqa: PLC0415

    log = setup_dir(app_folder) / ERROR_LOG
    if not log.is_file():
        return []
    rows = []
    with log.open() as lines:
        for line in deque(lines, maxlen=limit):
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows[::-1]


def _read_json(path: Path):
    try:
        return json.loads(path.read_text()) if path.is_file() else None
    except ValueError:
        return None


def page_was_clean(app_folder: str | Path) -> bool:
    """The app's page loaded clean the last time it was checked — or it was never checked."""
    last = last_check(app_folder)
    return last is None or bool(last.get("usable"))


def last_check(app_folder: str | Path) -> Optional[dict]:
    """The last page check of the app: ``{at, usable, outcome, errors}``, or None when never checked."""
    return _read_json(setup_dir(app_folder) / LAST_CHECK)


def setup_state(app_folder: str | Path) -> dict:
    """What the app editor's Setup tab shows: the rules, the recovery instructions, the error log."""
    base = setup_dir(app_folder)
    recovery = base / RECOVERY_FILE
    return {
        "setup_dir": str(base),
        "rules": [r.model_dump() for r in load_rules(app_folder)],
        "recovery_md": recovery.read_text() if recovery.is_file() else "",
        "errors": recent_errors(app_folder),
        "has_start_app": (base / "start_app.py").is_file(),
        "last_check": _read_json(base / LAST_CHECK),
    }


def set_rule_action(app_folder: str | Path, rule_id: str, action: str) -> bool:
    """Turn one rule to ``ignore`` or ``recover``; False when there is no such rule."""
    rules = load_rules(app_folder)
    if action not in ("ignore", "recover") or not any(r.id == rule_id for r in rules):
        return False
    updated = [r.model_copy(update={"action": action}) if r.id == rule_id else r for r in rules]
    (setup_dir(app_folder) / ERRORS_FILE).write_text(json.dumps([r.model_dump() for r in updated], indent=2) + "\n")
    return True

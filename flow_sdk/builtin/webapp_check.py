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


def triage(errors: list[PageError], rules: list[WebappErrorRule]) -> Verdict:
    """Each error against the rules, first match wins; an unknown error is ``recover``."""
    decisions = []
    for error in errors:
        rule = next((r for r in rules if _matches(r, error)), None)
        decisions.append(Decision(error=error, action=rule.action if rule else "recover", rule=rule))
    return Verdict(decisions)


def record(app_folder: str | Path, verdict: Verdict, outcome: str) -> None:
    """Append each decision to the app's error log, and count each matched rule as seen."""
    if not verdict.decisions:
        return
    base = setup_dir(app_folder)
    log = base / ERROR_LOG
    log.parent.mkdir(parents=True, exist_ok=True)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    with log.open("a") as out:
        for d in verdict.decisions:
            out.write(json.dumps({"at": now, "source": d.error.source, "text": d.error.text[:2000],
                                  "rule": d.rule.id if d.rule else None, "action": d.action,
                                  "outcome": outcome}) + "\n")
    seen = {d.rule.id for d in verdict.decisions if d.rule}
    if seen:
        rules = load_rules(app_folder)
        bumped = [r.model_copy(update={"seen": r.seen + 1}) if r.id in seen else r for r in rules]
        (base / ERRORS_FILE).write_text(json.dumps([r.model_dump() for r in bumped], indent=2) + "\n")

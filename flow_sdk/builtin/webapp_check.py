"""A web app's ``setup/`` folder as the app editor's Setup tab shows it: its learned handlings, its recovery notes,
its failure log, its lifecycle record.

Deciding is not here: a page error is matched and acted on by ``core/webapp/coordinator`` with the handlings of
``core/webapp/handling``. This module only reads and edits what the Setup tab shows.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.core.webapp import handling

SETUP_DIR = handling.SETUP_DIR
RECOVERY_FILE = handling.RECOVERY_FILE


def setup_dir(app_folder: str | Path) -> Path:
    return handling.setup_dir(app_folder)


def setup_state(app_folder: str | Path, webapp_id: str = "") -> dict:
    """What the Setup tab shows. A handlings file that cannot be read is shown as that, never as empty."""
    from flow_sdk.core.webapp import record  # noqa: PLC0415

    base = setup_dir(app_folder)
    recovery = base / RECOVERY_FILE
    try:
        own, problem = handling.load(app_folder), ""
    except handling.HandlingFileError as exc:
        own, problem = [], str(exc)
    return {
        "setup_dir": str(base),
        "handlings": [h.model_dump(mode="json") for h in own],
        "shipped": [h.model_dump(mode="json") for h in handling.shipped()],
        "handlings_problem": problem,
        "recovery_md": recovery.read_text() if recovery.is_file() else "",
        "errors": handling.recent(app_folder),
        "has_start_app": (base / "start_app.py").is_file(),
        "lifecycle": record.read(webapp_id).model_dump(mode="json") if webapp_id else None,
    }


def set_rule_action(app_folder: str | Path, rule_id: str, action: str) -> bool:
    """Turn one of the app's handlings to another action (``ignore``, ``restart``, ``escalate`` …)."""
    return handling.set_action(app_folder, rule_id, action)


__all__ = ["RECOVERY_FILE", "SETUP_DIR", "set_rule_action", "setup_dir", "setup_state"]

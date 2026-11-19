"""``monitor.json`` -- the on-disk shape of a ``Monitor``: one session's goal, checked on a cron mask.

It lives at ``agentic-assets/monitor/<process id>_monitor_<name>/``; the cron trigger that runs the check
(``flow process monitor-nudge <key>``) sits beside it at ``agentic-assets/trigger/<same key>/``.
"""

from __future__ import annotations

import re
from typing import ClassVar

from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec


class MonitorSpec(AssetDocumentSpec):
    main_file: ClassVar[str | None] = "monitor.json"
    #: A monitor's key -- its folder's name, and its trigger's -- is ``<agentic process id><KEY_SEP><name>``.
    KEY_SEP: ClassVar[str] = "_monitor_"
    #: A monitor's name: part of a folder name, so letters, digits, '-' and '_' only, up to 40.
    NAME_RE: ClassVar[re.Pattern[str]] = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")

    #: The monitor's own name (the key's last part).
    name: str
    #: The agentic process whose goal is watched.
    agentic_process_id: str
    #: What done looks like. A goal, a stop condition, or both.
    goal: str = ""
    #: When to stop even if the goal is not met.
    stop_condition: str = ""
    #: When to check: a crontab mask, the same one the trigger beside it runs on.
    cron: str

    @staticmethod
    def make_key(agentic_process_id: str, name: str) -> str:
        return f"{agentic_process_id}{MonitorSpec.KEY_SEP}{name}"

    @staticmethod
    def split_key(key: str) -> tuple[str, str]:
        """``(agentic process id, name)`` of a monitor key; ``ValueError`` when *key* is not one."""
        agentic_process_id, sep, name = key.partition(MonitorSpec.KEY_SEP)
        if not (sep and agentic_process_id and MonitorSpec.NAME_RE.fullmatch(name)):
            raise ValueError(f"{key!r} is not a monitor key (<agentic process id>{MonitorSpec.KEY_SEP}<name>).")
        return agentic_process_id, name

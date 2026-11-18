"""``monitor.json`` -- the on-disk shape of a ``Monitor``: one session's goal, checked on a cron mask.

It lives at ``agentic-assets/monitor/<process id>_monitor_<name>/``; the cron trigger that runs the check
(``flow process monitor-nudge <key>``) sits beside it at ``agentic-assets/trigger/<same key>/``.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec


class MonitorSpec(AssetDocumentSpec):
    main_file: ClassVar[str | None] = "monitor.json"

    #: The monitor's own name (the key's last part).
    name: str
    #: The agentic process whose goal is watched.
    process_id: str
    #: What done looks like. A goal, a stop condition, or both.
    goal: str = ""
    #: When to stop even if the goal is not met.
    stop_condition: str = ""
    #: When to check: a crontab mask, the same one the trigger beside it runs on.
    cron: str

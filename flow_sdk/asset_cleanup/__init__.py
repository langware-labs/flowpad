"""Asset cleanup — a haiku-agent scan that identifies garbage skills/agents.

The ``asset_cleanup`` system agent (``flowpad_assistant/.claude/agents/
asset_cleanup.md``) is the source of truth for the scan instructions and the
model tier. :func:`run_asset_cleanup` launches it as a one-shot headless
:class:`AgenticProcess` over the user home plus recently-active project roots
and returns the parsed findings. Identify-only — nothing is ever deleted.
"""
from .report import generate_asset_cleanup_report, render_markdown
from .run import AssetCleanupFinding, AssetCleanupResult, run_asset_cleanup
from .scan import collect_scan_roots

__all__ = [
    "AssetCleanupFinding",
    "AssetCleanupResult",
    "collect_scan_roots",
    "generate_asset_cleanup_report",
    "render_markdown",
    "run_asset_cleanup",
]

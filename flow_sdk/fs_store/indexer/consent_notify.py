"""Surface queued special-folder consent requests to the frontend.

Kept separate from ``special_folders.py`` (which is imported by the
dependency-light indexer factory / roots) so the WS-notify import
(``discovery.notify``) never risks a cycle there. Called by the scan/index
resolution path after roots are resolved.
"""

from __future__ import annotations

import logging

from flow_sdk.fs_store.indexer.special_folders import (
    CONSENT_EVENT_KIND,
    drain_pending_consent,
)

logger = logging.getLogger(__name__)


def surface_pending_consent() -> int:
    """Emit one WS ``index_folder_consent`` event per queued category.

    Deduped upstream (``note_consent_needed`` keys by category), so N projects
    under ~/Documents raise ONE prompt. Fire-and-forget; returns the count
    surfaced. Never raises.
    """
    events = drain_pending_consent()
    if not events:
        return 0
    from flow_sdk.discovery.notify import send_event  # noqa: PLC0415

    sent = 0
    for ev in events:
        try:
            send_event(CONSENT_EVENT_KIND, ev)
            sent += 1
        except Exception as e:  # noqa: BLE001
            logger.warning("surface_pending_consent: emit failed: %s", e)
    return sent

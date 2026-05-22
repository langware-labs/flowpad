"""FSOp wiring for the TranscriptStreamer.

Registers the route callback (at module import time) that bridges FSOp file-
change events to the registry, and exposes a spec factory for
``set_service_triggers()`` to consume.

Adding the streamer triggers to the canonical builtin list is a one-line edit
in ``flow_sdk/server/builtin_triggers.py:_service_trigger_specs()`` — call
:func:`transcript_watcher_trigger_specs(settings)` and extend the returned list.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import TriggerType
from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

_log = logging.getLogger(__name__)


@trigger_callbacks.register(
    "builtin_transcript_streamer_route",
    meaning="Routes transcript JSONL file changes (Claude / Codex sessions) "
            "to the per-session TranscriptStreamer. The streamer parses the "
            "delta and dispatches typed entries to registered subscribers.",
)
async def _route(_trigger: Any, changed_path: Any, _change_type: Any) -> None:
    try:
        await transcript_streamer_registry.notify_change(Path(changed_path))
    except Exception:
        _log.exception("transcript_streamer route: notify_change failed for %s", changed_path)


def transcript_watcher_trigger_specs(settings: Any) -> list[dict[str, Any]]:
    """Two FSOp trigger specs — one per worker dir. Consumed by
    ``set_service_triggers()`` at server boot."""
    return [
        dict(
            uname="builtin_claude_transcript_watcher",
            name="Claude transcript watcher",
            description="Watches ~/.claude/projects/ for JSONL file changes; "
                        "routes deltas to the per-session TranscriptStreamer.",
            trigger_type=TriggerType.FSOP,
            watch_path=str(settings.claude_projects_dir),
            recursive=True,
            watch_glob="*.jsonl",
            actions=[TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_transcript_streamer_route",
            )],
        ),
        dict(
            uname="builtin_codex_transcript_watcher",
            name="Codex transcript watcher",
            description="Watches ~/.codex/sessions/ for JSONL file changes; "
                        "routes deltas to the per-session TranscriptStreamer.",
            trigger_type=TriggerType.FSOP,
            watch_path=str(settings.codex_sessions_dir),
            recursive=True,
            watch_glob="*.jsonl",
            actions=[TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_transcript_streamer_route",
            )],
        ),
    ]

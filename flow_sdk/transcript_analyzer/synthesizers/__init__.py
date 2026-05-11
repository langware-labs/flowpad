"""Synthesizers — convert non-canonical sources into ``ProcessEntry`` objects.

Today: hook payloads → ProcessEntry. The hook channel observes the same
events the JSONL records, but in a different shape; the synthesizers normalize
them so every consumer reads one type.
"""

from .hook_to_entry import (
    synth_lifecycle_system_entry,
    synth_process_entry,
    synth_tool_result_entry,
    synth_tool_use_entry,
    synth_transcript_entry,
    synth_user_message_entry,
)

__all__ = [
    "synth_lifecycle_system_entry",
    "synth_process_entry",
    "synth_tool_result_entry",
    "synth_tool_use_entry",
    "synth_transcript_entry",
    "synth_user_message_entry",
]

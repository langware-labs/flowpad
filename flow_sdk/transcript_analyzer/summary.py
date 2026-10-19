"""Worker-generic extractive transcript summary for full-text search.

``worker_summary_log`` renders a session transcript (any worker — claude /
codex / copilot) into one extractive plain-text blob suitable for the FTS5
``content`` column. It is *extractive*, not abstractive: it joins the real
per-entry text (user/assistant messages, tool inputs, shell command output
previews) so a term typed in the conversation — e.g. ``twilio`` — appears
verbatim and is therefore searchable.

Driven by :class:`flow_sdk.transcript_analyzer.transcript.AgentTranscriptFile`,
which auto-selects the right parser for the worker type, so the same function
covers every worker. Callers are the session ``from_disk_fn`` extractors, which
set the result as the record's ``content`` (see ``fs_record.search_content``).
"""
from __future__ import annotations

import logging
from pathlib import Path
from textwrap import indent

from .entry import EntryKind
from .formats import TranscriptFormat
from .transcript import AgentTranscriptFile

logger = logging.getLogger(__name__)

# Entry kinds that carry real conversational / tool text worth indexing.
# Noise kinds (SYSTEM, META, TOKEN_USAGE, SUMMARY, UNKNOWN) are dropped — they
# bloat the index without adding searchable signal.
_SEARCHABLE_KINDS: frozenset[EntryKind] = frozenset(
    {
        EntryKind.USER_MESSAGE,
        EntryKind.ASSISTANT_MESSAGE,
        EntryKind.TOOL_USE,
        EntryKind.TOOL_RESULT,
        EntryKind.FILE_WRITE,
        EntryKind.FILE_EDIT,
        EntryKind.FILE_READ,
        EntryKind.SHELL_COMMAND,
        EntryKind.SEARCH,
        EntryKind.WEB_FETCH,
        EntryKind.TODO_UPDATE,
        EntryKind.AGENT_SPAWN,
    }
)

# Default per-session cap. FTS5 tolerates large documents, but a multi-MB blob
# per session wastes index space and slows upserts. Truncation drops only the
# occurrences past the cap, never the match itself.
_DEFAULT_MAX_CHARS = 256_000


def worker_summary_log(
    path: str | Path,
    worker_type: str,
    *,
    max_chars: int = _DEFAULT_MAX_CHARS,
    transcript_format: TranscriptFormat | str | None = None,
    number_entries: bool = False,
) -> str:
    """Return an extractive, search-indexable text rendering of a transcript.

    Worker-generic: ``worker_type`` is one of ``"claude"`` / ``"codex"`` /
    ``"copilot"`` (the parser is auto-selected). Keeps only entries whose kind
    carries real text (:data:`_SEARCHABLE_KINDS`) and joins their per-entry
    ``to_string()`` rendering. Capped at ``max_chars`` — a longer transcript is
    truncated and a warning is logged.

    ``transcript_format`` disambiguates worker formats that don't self-detect
    (e.g. Copilot ``events.jsonl`` needs ``"copilot_events"``); codex rollouts
    self-detect, so it's optional there.

    ``number_entries`` prefixes each rendered entry with ``[<i>]`` where ``i``
    is its position in ``AgentTranscriptFile.entries`` — the same index the
    ``session_analysis`` MCP tool takes to drill into one entry. Off by default
    so the search-indexed text stays free of positional noise.

    Best-effort: any parse/IO failure returns ``""`` so a malformed or partial
    transcript can never break session indexing.
    """
    try:
        transcript = AgentTranscriptFile(
            worker_type, Path(path), transcript_format=transcript_format
        )
        # Render entries only until we've accumulated past the cap, then stop —
        # a huge transcript would otherwise stringify every entry just to throw
        # away everything beyond max_chars. The prefix up to the cap (and thus
        # the final ``[:max_chars]``) is identical either way.
        parts: list[str] = []
        total = 0
        for i, e in enumerate(transcript.entries):
            if e.kind not in _SEARCHABLE_KINDS:
                continue
            body = e.to_string()
            if number_entries:
                body = f"[{i}] {body}"
            parts.append(body)
            total += len(body) + 2  # +2 for the "\n\n" separator
            if total > max_chars:
                break
        text = "\n\n".join(parts)
        if len(text) > max_chars:
            logger.warning(
                "worker_summary_log: truncating %s transcript %s to %d chars",
                worker_type,
                path,
                max_chars,
            )
            text = text[:max_chars]
        return text
    except Exception:
        logger.warning(
            "worker_summary_log: failed to render %s transcript %s (indexing empty content)",
            worker_type,
            path,
            exc_info=True,
        )
        return ""


def worker_continuation_prompt(
    path: str | Path,
    worker_type: str,
    worker_name: str,
    *,
    transcript_format: TranscriptFormat | str | None = None,
) -> str:
    """Build a deterministic, extractive prompt for a cross-worker handoff.

    The existing summary renderer owns filtering and its bounded transcript
    prefix. An empty summary is not a valid continuation: callers must surface
    that failure instead of sending a context-free provider-switch prompt.
    """
    summary = worker_summary_log(
        path,
        worker_type,
        transcript_format=transcript_format,
    )
    if not summary:
        raise ValueError("Transcript has no readable conversation to continue")
    # The entry renderer uses ``==== kind id ====`` banners. Without a blank
    # line + indentation, Markdown treats that next line as a Setext heading
    # underline and renders the intro as an enormous H1 in chat.
    rendered_summary = indent(summary, "    ")
    return (
        f"We are continuing the conversation from {worker_name}:\n\n"
        f"{rendered_summary}"
    )

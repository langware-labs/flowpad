"""SessionReader — spec §8. The two folds are ``_parse_jsonl_stats`` and
``_parse_codex_jsonl_stats``; a file either of them cannot read arrives as a
value carrying ``error``, never as an exception out of the batch. Sequential:
``threads`` is a cap this backend ignores."""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterator, Sequence, TypeVar

from flow_sdk.diskio.contract import ClaudeSessionStats, CodexSessionStats, ItemError, StreamEnd
from flow_sdk.diskio.python._stream import unreadable, with_end

S = TypeVar("S", ClaudeSessionStats, CodexSessionStats)

#: Not JSONL facts: the wrapper fills both from the value (spec §8).
_WRAPPER_KEYS = ("task_path", "estimated_cost_usd")

_EMPTY_CLAUDE = dict(
    session_id="", cwd="", version="", git_branch="", slug="", model=None, message_count=0,
    user_message_count=0, assistant_message_count=0, input_tokens=0, output_tokens=0,
    cache_read_input_tokens=0, cache_creation_input_tokens=0, duration_ms=0, tools_used=(),
    has_plan=False, last_stop_reason=None, last_user_message=None, modified_at=None,
    models_used=(), primary_model=None, created_at=None, search_content=None,
)
_EMPTY_CODEX = dict(
    session_id="", cwd="", version="", originator="", git_branch="", model=None, effort=None,
    personality=None, approval_policy=None, sandbox_policy=None, message_count=0,
    user_message_count=0, assistant_message_count=0, tool_uses=0, input_tokens=0,
    output_tokens=0, cache_read_input_tokens=0, cache_creation_input_tokens=0,
    last_user_message=None, last_assistant_message=None, last_stop_reason=None,
    modified_at=None, created_at=None, models_used=(), primary_model=None, search_content=None,
)


def _open_error(path: str) -> ItemError | None:
    """Why a fold that aggregated nothing saw nothing: both folds swallow the
    ``OSError`` of an unreadable file and return zeros."""
    try:
        with open(path, "rb"):
            return None
    except OSError as exc:
        return unreadable(path, exc)


def _stats(path: str, fold: Callable[[Path], dict], cls: type[S], empty: dict, *, drop: tuple[str, ...]) -> S:
    try:
        raw = fold(Path(path))
        stats = {key: value for key, value in raw.items() if key not in drop}
        error = None if raw.get("message_count") or raw.get("created_at") else _open_error(path)
        return cls(path=path, error=error, **stats)
    except Exception as exc:  # noqa: BLE001 — one bad transcript never aborts the batch
        # Invalid UTF-8, a line that is JSON but not an object, a value of the
        # wrong type: today each raises out of the fold with nothing aggregated.
        return cls(path=path, error=ItemError(path=path, kind="decode", detail=f"{type(exc).__name__}: {exc}"),
                   **{**empty, "session_id": Path(path).stem})


class PySessionReader:
    def claude(self, paths: Sequence[str], *, threads: int = 1) -> Iterator[ClaudeSessionStats | StreamEnd]:
        from flow_sdk.fs_store.indexer.functions._claude_session_stats import _parse_jsonl_stats  # noqa: PLC0415

        return with_end(
            _stats(path, _parse_jsonl_stats, ClaudeSessionStats, _EMPTY_CLAUDE, drop=_WRAPPER_KEYS)
            for path in paths
        )

    def codex(self, paths: Sequence[str], *, threads: int = 1) -> Iterator[CodexSessionStats | StreamEnd]:
        from flow_sdk.fs_store.indexer.functions._codex_session_stats import _parse_codex_jsonl_stats  # noqa: PLC0415

        return with_end(
            _stats(path, _parse_codex_jsonl_stats, CodexSessionStats, _EMPTY_CODEX, drop=())
            for path in paths
        )

"""Session collector - sessions with token tracking."""

import json
from pathlib import Path

from .project_collector import (
    get_project_cwd,
)
from ..utils import (
    CLAUDE_HOME,
    calculate_session_cost,
)

_NAME_PREFIXES_TO_STRIP = [
    "Implement the following plan:",
    "Launch the ",
]


def _clean_session_name(name: str) -> str:
    """Strip verbose prefixes from session names."""
    for prefix in _NAME_PREFIXES_TO_STRIP:
        if name.startswith(prefix):
            return name[len(prefix) :].strip()
    return name


def _extract_canonical_session_id(entry: dict) -> str | None:
    """Extract canonical Claude session UUID from a transcript entry."""
    candidate = entry.get("sessionId") or entry.get("session_id")
    if isinstance(candidate, str):
        value = candidate.strip()
        if value:
            return value
    return None


def _resolve_tasks_path(primary_session_id: str, fallback_session_id: str | None = None) -> str | None:
    """Find tasks directory for a session, trying canonical and fallback IDs."""
    candidates = [primary_session_id]
    if fallback_session_id and fallback_session_id != primary_session_id:
        candidates.append(fallback_session_id)

    for candidate in candidates:
        tasks_dir = Path.home() / ".claude" / "tasks" / candidate
        if tasks_dir.exists() and any(tasks_dir.glob("*.json")):
            return str(tasks_dir)
    return None


def get_session_info_quick(jsonl_path: Path, project_encoded_name: str | None = None) -> dict | None:
    """Get basic info about a session using file metadata only (FAST).

    This reads only the first few lines to get timestamps and slug,
    avoiding full file parsing.
    """
    if not jsonl_path.exists():
        return None

    session_file_id = jsonl_path.stem
    canonical_session_id = None
    if not project_encoded_name:
        project_encoded_name = jsonl_path.parent.name
    stat = jsonl_path.stat()
    size_bytes = stat.st_size
    modified_at = None

    # Read first few lines for created_at timestamp, slug, and first user message.
    # Also read last lines of file for summary (may be written mid/end of session).
    first_timestamp = None
    slug = None
    summary = None
    first_user_message = None
    cwd = None
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            # Read up to 30 lines from the start
            for _ in range(30):
                line = f.readline()
                if not line:
                    break
                try:
                    entry = json.loads(line)
                    if not first_timestamp:
                        first_timestamp = entry.get("timestamp")
                    if not canonical_session_id:
                        canonical_session_id = _extract_canonical_session_id(entry)
                    if not slug and "slug" in entry:
                        slug = entry.get("slug")
                    if not cwd:
                        cwd = entry.get("cwd")
                    if entry.get("type") == "summary":
                        summary = entry.get("summary") or summary
                    # Extract first real user message text as fallback name
                    # Skip system/command noise lines (tags like <local-command-*>, <command-name>, etc.)
                    if not first_user_message and entry.get("type") == "user":
                        msg = entry.get("message", {})
                        content = msg.get("content") if isinstance(msg, dict) else None
                        if isinstance(content, str):
                            text = content.strip()
                            if text and not text.startswith("<"):
                                first_user_message = text[:120]
                        elif isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    text = block.get("text", "").strip()
                                    if text and not text.startswith("<"):
                                        first_user_message = text[:120]
                                        break
                    # Stop early if we found a summary plus basics
                    if first_timestamp and slug and summary:
                        break
                except json.JSONDecodeError:
                    continue

        # Scan tail of file for summary and last user message
        last_user_message = None
        if size_bytes > 0:
            tail_size = min(size_bytes, 64 * 1024)  # read last 64KB at most
            with open(jsonl_path, "rb") as fb:
                fb.seek(max(0, size_bytes - tail_size))
                if size_bytes > tail_size:
                    fb.readline()  # skip partial first line after seek
                tail_data = fb.read().decode("utf-8", errors="replace")
            last_stop_reason = None
            for line in tail_data.splitlines():
                try:
                    entry = json.loads(line)
                    if not canonical_session_id:
                        canonical_session_id = _extract_canonical_session_id(entry)
                    if entry.get("type") == "summary":
                        summary = entry.get("summary") or summary
                    elif entry.get("type") == "assistant":
                        msg = entry.get("message", {})
                        if isinstance(msg, dict):
                            sr = msg.get("stop_reason")
                            if sr:
                                last_stop_reason = sr
                    elif entry.get("type") == "user":
                        msg = entry.get("message", {})
                        content = msg.get("content") if isinstance(msg, dict) else None
                        if isinstance(content, str):
                            text = content.strip()
                            if text and not text.startswith("<"):
                                last_user_message = text[:120]
                        elif isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    text = block.get("text", "").strip()
                                    if text and not text.startswith("<"):
                                        last_user_message = text[:120]
                except (json.JSONDecodeError, ValueError):
                    continue
    except IOError:
        pass

    # Fast message count: scan raw bytes for type markers without JSON parsing
    user_messages = 0
    assistant_messages = 0
    try:
        raw = jsonl_path.read_bytes()
        user_messages = raw.count(b'"type":"user"') + raw.count(b'"type": "user"')
        assistant_messages = raw.count(b'"type":"assistant"') + raw.count(b'"type": "assistant"')
    except IOError:
        pass
    message_count = user_messages + assistant_messages

    # Use file mtime as modified_at (faster than reading last line)
    from datetime import datetime

    modified_at = datetime.fromtimestamp(stat.st_mtime).isoformat()

    # Check if plan file exists for this slug
    plan_path = None
    if slug:
        potential_plan = CLAUDE_HOME / "plans" / f"{slug}.md"
        if potential_plan.exists():
            plan_path = str(potential_plan)

    resolved_session_id = canonical_session_id or session_file_id
    task_path = _resolve_tasks_path(resolved_session_id, session_file_id)

    # Skip empty/broken sessions with no conversation content
    if message_count == 0:
        return None

    return {
        "id": session_file_id,
        "session_id": resolved_session_id,
        "type": "claude_session",
        "name": _clean_session_name(summary or first_user_message or resolved_session_id),
        "scope": "user",
        "source_file": str(jsonl_path),
        "path": str(jsonl_path),
        "cwd": cwd,
        "modified_at": modified_at,
        "created_at": first_timestamp,
        "project_id": f"project:{project_encoded_name}" if project_encoded_name else None,
        "project_encoded_name": project_encoded_name,
        "size_bytes": size_bytes,
        "slug": slug,
        "plan_path": plan_path,
        "task_path": task_path,
        "last_user_message": last_user_message,
        "message_count": message_count,
        "user_messages": user_messages,
        "assistant_messages": assistant_messages,
        "tool_uses": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "estimated_cost_usd": 0.0,
        "last_stop_reason": last_stop_reason,
        "models_used": [],
        "primary_model": None,
    }


def _collect_assistant_entries(jsonl_path: Path, request_data: dict, no_request_data: list) -> None:
    """Parse assistant entries from a JSONL file, deduplicating by messageId:requestId.

    Claude Code writes multiple JSONL lines per API call (streaming updates)
    that share the same requestId.  We keep only the FIRST entry per unique
    messageId:requestId pair (matching ccusage behaviour).

    Args:
        jsonl_path: Path to the JSONL file to parse.
        request_data: Dict of dedup_key -> entry data (mutated in place).
        no_request_data: List for entries without a dedup key (mutated).
    """
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
                if entry.get("type") != "assistant":
                    continue
                msg = entry.get("message", {})
                usage = msg.get("usage", {})

                message_id = msg.get("id")
                request_id = entry.get("requestId")
                dedup_key = f"{message_id}:{request_id}" if message_id and request_id else None

                content = msg.get("content", [])
                tool_count = 0
                if isinstance(content, list):
                    tool_count = sum(
                        1
                        for c in content
                        if isinstance(c, dict) and c.get("type") == "tool_use"
                    )

                data = {
                    "input": usage.get("input_tokens", 0),
                    "output": usage.get("output_tokens", 0),
                    "cache_read": usage.get("cache_read_input_tokens", 0),
                    "cache_create": usage.get("cache_creation_input_tokens", 0),
                    "model": msg.get("model"),
                    "tool_uses": tool_count,
                }

                if dedup_key:
                    if dedup_key not in request_data:  # first entry wins
                        request_data[dedup_key] = data
                else:
                    no_request_data.append(data)
            except json.JSONDecodeError:
                continue


def get_session_info(jsonl_path: Path, project_encoded_name: str | None = None) -> dict | None:
    """Get info about a single session including token usage and cost (SLOW - parses full file)."""
    if not jsonl_path.exists():
        return None

    session_file_id = jsonl_path.stem
    canonical_session_id = None
    if not project_encoded_name:
        project_encoded_name = jsonl_path.parent.name
    first_timestamp = None
    last_timestamp = None
    user_messages = 0
    git_branch = None
    version = None
    slug = None
    summary = None
    cwd = None

    last_stop_reason = None

    # First pass: collect metadata and user message count
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)

                    if ts := entry.get("timestamp"):
                        if not first_timestamp:
                            first_timestamp = ts
                        last_timestamp = ts
                    if not canonical_session_id:
                        canonical_session_id = _extract_canonical_session_id(entry)

                    if not slug and "slug" in entry:
                        slug = entry.get("slug")
                    if not cwd:
                        cwd = entry.get("cwd")

                    # Extract summary - may appear multiple times, keep latest
                    if entry.get("type") == "summary":
                        summary = entry.get("summary") or summary

                    if entry.get("type") == "user":
                        user_messages += 1

                    if entry.get("type") == "assistant":
                        msg = entry.get("message", {})
                        if isinstance(msg, dict):
                            sr = msg.get("stop_reason")
                            if sr:
                                last_stop_reason = sr

                    if not git_branch:
                        git_branch = entry.get("gitBranch")
                    if not version:
                        version = entry.get("version")

                except json.JSONDecodeError:
                    continue
    except IOError:
        return None

    # Collect deduplicated assistant entries from main session + subagents
    request_data: dict = {}
    no_request_data: list = []

    try:
        _collect_assistant_entries(jsonl_path, request_data, no_request_data)
    except IOError:
        return None

    resolved_session_id = canonical_session_id or session_file_id

    # Include tokens from subagent JSONL files (e.g. Task-spawned agents)
    # Prefer legacy filename path, but also check canonical UUID path when different.
    subagent_dirs = [jsonl_path.parent / session_file_id / "subagents"]
    if resolved_session_id != session_file_id:
        subagent_dirs.append(jsonl_path.parent / resolved_session_id / "subagents")
    seen_subagent_files = set()
    for subagents_dir in subagent_dirs:
        if not subagents_dir.is_dir():
            continue
        for subagent_file in subagents_dir.glob("*.jsonl"):
            subagent_key = str(subagent_file.resolve())
            if subagent_key in seen_subagent_files:
                continue
            seen_subagent_files.add(subagent_key)
            try:
                _collect_assistant_entries(subagent_file, request_data, no_request_data)
            except IOError:
                continue

    # Compute totals from deduplicated entries
    all_entries = list(request_data.values()) + no_request_data
    assistant_messages = len(all_entries)
    message_count = user_messages + assistant_messages

    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_creation_tokens = 0
    tool_uses = 0
    models_used = {}

    for entry_data in all_entries:
        input_tokens += entry_data["input"]
        output_tokens += entry_data["output"]
        cache_read_tokens += entry_data["cache_read"]
        cache_creation_tokens += entry_data["cache_create"]
        tool_uses += entry_data["tool_uses"]
        model = entry_data["model"]
        if model:
            models_used[model] = models_used.get(model, 0) + 1

    primary_model = None
    if models_used:
        primary_model = max(models_used.items(), key=lambda x: x[1])[0]

    cost_info = calculate_session_cost(
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        primary_model,
    )

    # Check if plan file exists for this slug
    plan_path = None
    if slug:
        potential_plan = CLAUDE_HOME / "plans" / f"{slug}.md"
        if potential_plan.exists():
            plan_path = str(potential_plan)

    task_path = _resolve_tasks_path(resolved_session_id, session_file_id)

    # Skip empty/broken sessions with no conversation content
    if message_count == 0:
        return None

    return {
        "id": session_file_id,
        "session_id": resolved_session_id,
        "type": "claude_session",
        "name": _clean_session_name(summary or resolved_session_id),
        "scope": "user",
        "source_file": str(jsonl_path),
        "path": str(jsonl_path),
        "cwd": cwd,
        "modified_at": last_timestamp,
        "created_at": first_timestamp,
        "project_id": f"project:{project_encoded_name}" if project_encoded_name else None,
        "project_encoded_name": project_encoded_name,
        "message_count": message_count,
        "user_messages": user_messages,
        "assistant_messages": assistant_messages,
        "tool_uses": tool_uses,
        "git_branch": git_branch,
        "version": version,
        "slug": slug,
        "plan_path": plan_path,
        "task_path": task_path,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_creation_tokens": cache_creation_tokens,
        "estimated_cost_usd": cost_info["total"],
        "last_stop_reason": last_stop_reason,
        "models_used": list(models_used.keys()),
        "primary_model": primary_model,
    }


def get_recent_sessions(limit: int = 10, per_project_limit: int = 0, quick: bool = True) -> list[dict]:
    """Get recent sessions across all projects.

    Args:
        limit: Maximum total sessions to return (0 = unlimited)
        per_project_limit: Max sessions per project (0 = unlimited, default)
        quick: Use quick mode (file metadata only) for faster listing (default True).
               Set to False to get full token/cost data (slower).
    """
    projects_dir = CLAUDE_HOME / "projects"

    if not projects_dir.exists():
        return []

    # Phase 1: Collect all (mtime, path, project_name) tuples with cheap stat() calls.
    # This avoids parsing any file content until we know which files we actually need.
    file_entries: list[tuple[float, Path, str]] = []
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        project_encoded_name = project_dir.name
        project_files = []
        for jsonl_file in project_dir.glob("*.jsonl"):
            try:
                mtime = jsonl_file.stat().st_mtime
            except OSError:
                continue
            project_files.append((mtime, jsonl_file, project_encoded_name))
        # Apply per-project limit by keeping only the newest files per project
        if per_project_limit > 0:
            project_files.sort(key=lambda x: x[0], reverse=True)
            project_files = project_files[:per_project_limit]
        file_entries.extend(project_files)

    # Phase 2: Sort all files globally by mtime (newest first) and take only
    # the top `limit` entries. This is the key optimisation: when quick=False
    # (full JSONL parse), we now only parse the files we will actually return
    # instead of parsing every session across every project.
    file_entries.sort(key=lambda x: x[0], reverse=True)
    if limit > 0:
        file_entries = file_entries[:limit]

    # Phase 3: Parse only the selected files.
    session_info_fn = get_session_info_quick if quick else get_session_info
    # Cache cwd lookups per project to avoid redundant scans
    _cwd_cache: dict[str, str] = {}
    recent = []
    for _mtime, sf, project_encoded_name in file_entries:
        session = session_info_fn(sf, project_encoded_name)
        if session:
            if project_encoded_name not in _cwd_cache:
                project_dir = sf.parent
                _cwd_cache[project_encoded_name] = get_project_cwd(project_dir) or project_dir.name
            session["cwd"] = _cwd_cache[project_encoded_name]
            recent.append(session)

    # Already sorted by mtime from Phase 2, but re-sort by modified_at for consistency
    # (modified_at may differ slightly from file mtime)
    recent.sort(key=lambda x: x["modified_at"] or "", reverse=True)
    return recent

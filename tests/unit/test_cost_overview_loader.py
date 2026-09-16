"""The cost overview loads token stats without building transcript search text.

``extract_claude_session_from_path`` builds the searchable ``content`` with a
full transcript parse; the cost aggregation never reads it, and the stats pass
parses every file again. Home loads this for the 100 newest sessions on every
refresh (~206MB), so the content parse doubled its cost.
"""

import json

from flow_sdk.builtin.faas.analytics.cost_overview import load_recent_sessions_for_cost

SID = "11111111-1111-4111-8111-111111111111"


def test_recent_sessions_carry_token_stats_without_search_content(claude_projects):
    rows = [
        {"type": "user", "message": {"role": "user", "content": "Summarize the release notes"},
         "uuid": "u1", "timestamp": "2026-09-16T10:00:00Z", "cwd": "/repo", "sessionId": SID},
        {"type": "assistant", "uuid": "a1", "parentUuid": "u1", "timestamp": "2026-09-16T10:00:05Z",
         "cwd": "/repo", "sessionId": SID,
         "message": {"role": "assistant", "model": "claude-opus-5", "content": [{"type": "text", "text": "Done."}],
                     "usage": {"input_tokens": 1200, "output_tokens": 340,
                               "cache_read_input_tokens": 50, "cache_creation_input_tokens": 7}}},
    ]
    (claude_projects / f"{SID}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")

    session, = load_recent_sessions_for_cost(limit=10)

    assert (session["input_tokens"], session["output_tokens"]) == (1200, 340)
    assert (session["cache_read_tokens"], session["cache_creation_tokens"]) == (50, 7)
    assert session["primary_model"] == "claude-opus-5"
    assert session["content"] == ""

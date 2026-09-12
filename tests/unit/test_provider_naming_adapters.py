"""Native title formats, real files/stores, no worker or browser needed."""
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

from flow_sdk.assets.types.claude_titles import read_claude_title
from flow_sdk.builtin.agentic_process.naming.providers import (
    ClaudeNamingAdapter,
    CodexNamingAdapter,
    CopilotNamingAdapter,
    OpenCodeNamingAdapter,
)
from flow_sdk.builtin.agentic_process.naming.state import NameOrigin


def _process():
    return SimpleNamespace(session_id='test-session')


def test_claude_manual_survives_growth_and_later_auto(tmp_path):
    path = tmp_path / 'session.jsonl'
    path.write_text(json.dumps({'type': 'ai-title', 'aiTitle': 'Early auto'}) + '\n')
    assert read_claude_title(path).title == 'Early auto'
    with path.open('a') as out:
        out.write(json.dumps({'type': 'custom-title', 'customTitle': 'Session'}) + '\n')
        out.write(json.dumps({'type': 'user', 'message': 'x' * 20000}) + '\n')
        out.write(json.dumps({'type': 'ai-title', 'aiTitle': 'Later auto'}) + '\n')
    title = read_claude_title(path)
    assert title.title == 'Session' and title.explicit


def test_claude_partial_line_rotation_and_deleted_file(tmp_path):
    path = tmp_path / 'session.jsonl'
    path.write_text('{"type":"custom-title","customTitle":"Manual"}')
    assert read_claude_title(path) is None
    with path.open('a') as out:
        out.write('\n')
    assert read_claude_title(path).title == 'Manual'
    path.unlink()
    assert read_claude_title(path).title == 'Manual'
    path.write_text('{"type":"ai-title","aiTitle":"Replacement"}\n')
    assert read_claude_title(path).title == 'Replacement'


def test_codex_only_complete_latest_matching_record(tmp_path):
    path = tmp_path / 'session_index.jsonl'
    records = [{'id': 'test-session', 'thread_name': 'First'},
               {'id': 'other', 'thread_name': 'Unrelated'},
               {'id': 'test-session', 'thread_name': 'Second'}]
    path.write_text(''.join(json.dumps(r) + '\n' for r in records) + '{"id":')
    class Adapter(CodexNamingAdapter):
        def watch_paths(self, process):
            return (path,)
    item, = Adapter().read(_process())
    assert item.title == 'Second' and item.origin == NameOrigin.UNKNOWN


def test_copilot_explicit_boolean_provenance_and_multiline(tmp_path):
    path = tmp_path / 'workspace.yaml'
    class Adapter(CopilotNamingAdapter):
        def watch_paths(self, process):
            return (path,)
    for flag, origin in [('true', NameOrigin.EXPLICIT_USER), ('false', NameOrigin.HARNESS_AUTO), ('null', NameOrigin.UNKNOWN)]:
        path.write_text(f'name: |-\n  A title:\n  with punctuation\nuser_named: {flag}\n')
        item, = Adapter().read(_process())
        assert item.origin == origin and item.title == 'A title:\nwith punctuation'
    path.write_text('name: [malformed')
    assert Adapter().read(_process()) == []


def test_opencode_reads_committed_wal_and_filters_native_placeholder(tmp_path):
    path = tmp_path / 'opencode.db'
    class Adapter(OpenCodeNamingAdapter):
        def watch_paths(self, process):
            return (path, Path(str(path) + '-wal'))
    with sqlite3.connect(path) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE session (id TEXT, title TEXT, time_updated INTEGER)')
        db.execute('INSERT INTO session VALUES (?, ?, ?)', ('test-session', 'New session - 2026-09-13T10:00:00Z', 1))
        db.commit()
        assert Adapter().read(_process()) == []
        db.execute('UPDATE session SET title = ?, time_updated = 2', ('A durable title',))
        db.commit()
        item, = Adapter().read(_process())
        assert item.title == 'A durable title' and item.origin == NameOrigin.UNKNOWN


def test_claude_terminal_backup_is_filtered_and_preserves_uncertainty():
    class Adapter(ClaudeNamingAdapter):
        def read(self, process):
            return []
    adapter = Adapter()
    assert adapter.terminal_observation(_process(), 'Claude Code') is None
    assert adapter.terminal_observation(_process(), '⠋ Claude') is None
    item = adapter.terminal_observation(_process(), '⠋ Fix Hebrew עברית')
    assert item.title == 'Fix Hebrew עברית' and item.origin == NameOrigin.UNKNOWN


def test_session_store_environment_matches_discovery_and_rejects_conflicts(tmp_path):
    import pytest

    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import apply_worker_env
    from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.driver import OpenCodeDriver

    for driver in (CodexDriver(), CopilotDriver(), OpenCodeDriver()):
        process = SimpleNamespace(driver=driver, id='test', get_type=lambda: 'agentic_process')
        env = apply_worker_env({}, process)
        for key, configured in driver.session_store_env.items():
            assert env[key] == configured
            with pytest.raises(ValueError, match='configured session store'):
                apply_worker_env({key: str(tmp_path / 'wrong-store')}, process)


def test_codex_old_appended_timestamp_cannot_replace_newer_record(tmp_path):
    path = tmp_path / 'session_index.jsonl'
    path.write_text('\n'.join(json.dumps({'id': 'test-session', 'thread_name': title, 'updated_at': time})
                              for title, time in [('Newer', '2026-09-13T10:00:00Z'),
                                                  ('Older', '2026-09-12T10:00:00Z')]) + '\n')
    class Adapter(CodexNamingAdapter):
        def watch_paths(self, process):
            return (path,)
    assert Adapter().read(_process())[0].title == 'Newer'


def test_codex_index_shared_incremental_cursor_and_partial_tail(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    from flow_sdk.assets.types.codex_titles import read_codex_title

    path = tmp_path / 'session_index.jsonl'
    path.write_text('{"id":"first","thread_name":"Original"}\n')
    original = read_codex_title(path, 'first')
    # Unchanged reads across independent callers reuse the immutable value.
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert all(value is original for value in pool.map(lambda _: read_codex_title(path, 'first'), range(20)))
    with path.open('a') as out:
        out.write('{"id":"second","thread_name":"Completed later"}')
    assert read_codex_title(path, 'second') is None
    assert read_codex_title(path, 'first') is original
    with path.open('a') as out:
        out.write('\n')
    assert read_codex_title(path, 'second').title == 'Completed later'
    assert read_codex_title(path, 'first') is original


def test_codex_index_replacement_truncation_and_missing_file(tmp_path):
    from flow_sdk.assets.types.codex_titles import read_codex_title

    path = tmp_path / 'session_index.jsonl'
    path.write_text('{"id":"first","thread_name":"An older longer title"}\n')
    assert read_codex_title(path, 'first').title == 'An older longer title'
    path.write_text('{"id":"first","thread_name":"Short"}\n')
    assert read_codex_title(path, 'first').title == 'Short'
    replacement = tmp_path / 'replacement.jsonl'
    replacement.write_text('{"id":"second","thread_name":"Replacement"}\n')
    replacement.replace(path)
    assert read_codex_title(path, 'first') is None
    assert read_codex_title(path, 'second').title == 'Replacement'
    path.unlink()
    assert read_codex_title(path, 'second').title == 'Replacement'

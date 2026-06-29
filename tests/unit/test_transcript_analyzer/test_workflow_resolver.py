"""resolve_session_jsonl("workflow", run_id) finds the wf_<runId>.json journal
under ~/.claude/projects/<slug>/<sid>/workflows/, mirroring the claude/codex paths.
"""
import pytest

from flow_sdk.transcript_analyzer import resolver as resolver_mod
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    resolve_session_jsonl,
)

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

RUN_ID = "wf_a8e936fe-3a9"


@pytest.fixture()
def fake_projects(tmp_path, monkeypatch):
    projects = tmp_path / ".claude" / "projects"
    run_dir = projects / "-some-slug" / "11111111-1111-4111-8111-111111111111" / "workflows"
    run_dir.mkdir(parents=True)
    journal = run_dir / f"{RUN_ID}.json"
    journal.write_text('{"runId": "wf_a8e936fe-3a9"}', encoding="utf-8")
    monkeypatch.setattr(resolver_mod, "_claude_projects_dir", lambda: projects)
    return journal


def test_resolve_workflow_finds_journal(fake_projects):
    assert resolve_session_jsonl("workflow", RUN_ID) == fake_projects


def test_resolve_workflow_missing_raises(fake_projects):
    with pytest.raises(TranscriptNotFoundError):
        resolve_session_jsonl("workflow", "wf_does-not-exist")

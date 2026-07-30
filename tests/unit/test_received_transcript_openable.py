"""A received transcript must be openable on a machine that never ran it.

This is the Docker / second-machine failure:

    Error Loading Transcript
    NOT_FOUND: ~/.claude/projects/ not found; cannot resolve session <id>

The chip opens a transcript by ``asset_ref`` when the entity has one, and only
falls back to the session id otherwise (``EntityChip.tsx``:
``DockPointer.forLensTranscript(worker, ref || resolved.id)``). The id route is
deliberately local-only — ``resolve_session_jsonl``'s contract is that a
received transcript "is addressed by its asset_ref path, not by session id" —
so on a machine that never ran the session it MUST resolve by path or not at
all.

``asset_ref`` comes from the entity row, and the row only exists if something
indexes the installed file. On a single machine this is invisible: both
instances share ``~/.claude/``, so ``ClaudeSession._recover_from_disk`` finds
the SENDER's copy and hands back an entity whose ``asset_ref`` points at their
file. This test removes that accident — the worker's own store is empty, as it
is in Docker — leaving the installed copy as the only possible answer.

Enters through the real install reindex (``_reindex_received_assets``, the call
``index_attachments`` makes) and the real ``ClaudeSession.get_by_id`` the
entity GET serves. Nothing is mocked.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.placement import Scope, resolve_destination
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    resolve_session_jsonl,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

_TRANSCRIPT = (
    '{{"sessionId":"{sid}","cwd":"/senders/machine/proj","type":"user",'
    '"timestamp":"2026-07-29T10:00:00Z","message":{{"role":"user","content":"hi"}}}}\n'
)


@pytest.fixture()
def receiver_machine(tmp_path, monkeypatch):
    """A machine that never ran the shared session — its Claude store is empty.

    ``FLOWPAD_CLAUDE_HOME`` is the single knob for where Flowpad reads worker
    transcripts, so pointing it at an empty tmp dir reproduces Docker / a second
    machine exactly: the sender's copy simply isn't there to be found.
    """
    claude_home = tmp_path / "receiver-home" / ".claude"
    (claude_home / "projects").mkdir(parents=True)
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(claude_home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude_home))
    reset_instance_settings()
    yield get_instance_settings()
    reset_instance_settings()


async def test_installed_transcript_is_openable_without_a_local_run(tmp_path: Path, receiver_machine) -> None:
    projects_dir = receiver_machine.claude_projects_dir
    assert not list(projects_dir.glob("*/*.jsonl")), "fixture broken: receiver must have no local sessions"

    receiver_root = tmp_path / "cyber-docker"
    receiver_root.mkdir(parents=True)
    proj = Project(
        id=Project.derive_id_for_path(str(receiver_root)),
        name="cyber-docker",
        fs_storage_mount_path=str(receiver_root),
    )
    await proj.save()

    # The bytes DID arrive — the install dialog previews them fine — and land at
    # the placement layer's destination for this type. ASKED, not hardcoded: this
    # type is a REPO asset, so its family dir moved out of `.claude/transcripts`
    # when harness dot-dirs were narrowed to what the harness actually reads back.
    sid = str(uuid.uuid4())
    dest_dir = resolve_destination(
        RecordType.CLAUDE_SESSION.value,
        Scope.PROJECT,
        default_worker="claude",
        project_mount=receiver_root,
    )
    assert dest_dir is not None, "claude_session must have a project-scoped placement"
    installed = dest_dir / f"{sid}.jsonl"
    installed.parent.mkdir(parents=True, exist_ok=True)
    installed.write_text(_TRANSCRIPT.format(sid=sid), encoding="utf-8")

    from flow_sdk.builtin.flow_message_bundle import _reindex_received_assets

    await _reindex_received_assets(receiver_root, (RecordType.CLAUDE_SESSION,), project_id=proj.id)

    # The id route cannot rescue this and is not meant to — it is exactly the
    # error the user sees. Asserted so the test states WHY asset_ref is the only
    # viable route, not merely that it is missing.
    with pytest.raises(TranscriptNotFoundError):
        resolve_session_jsonl("claude", sid)

    session = await ClaudeSession.get_by_id(sid)
    assert session is not None, (
        "installed transcript has no entity row, so the chip has no asset_ref and falls back "
        "to the session id — which is the NOT_FOUND the receiver sees"
    )
    assert session.asset_ref == str(installed), (
        f"the transcript must be addressed by the INSTALLED copy; got {session.asset_ref!r}"
    )


@pytest.mark.parametrize("type_name", ["claude_session", "codex_session", "copilot_session"])
async def test_session_types_may_announce_themselves(type_name: str) -> None:
    """A row nobody hears about is the same as no row.

    The broadcast gate in ``resource_tracker._sync_handle_entity_op`` drops every
    ``data_op`` whose type isn't api-visible, and its one exemption covers
    update/delete — a CREATE never qualifies. So with this False, install writes
    the row correctly and announces it into a void: the open conversation keeps
    the 404 it cached beforehand, leaving the chip dashed AND leaving it without
    the ``asset_ref`` it needs, so opening falls back to a session-id lookup that
    cannot resolve on a machine that never ran the session.

    This defaulted False on all three types from the initial 0.2.0 import, while
    every sibling (``remote_worker_session``, ``agent_trace``, ``workflow_run``,
    ``usage_report``) is visible — so it reads as inherited, not decided. Guarded
    here because nothing else would notice it flipping back.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    assert SchemaRegistry.is_api_visible(type_name), (
        f"{type_name} must be api-visible or install's CREATE is dropped before any client sees it"
    )

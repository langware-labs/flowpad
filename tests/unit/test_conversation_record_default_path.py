"""Unit tests for `ConversationRecord.default_data_dir` / `default_jsonl_path`.

Validates that a Conversation's data file resolves to the same canonical
records-data location every other record uses, so:
- the layout is consistent across record types,
- test fixtures that rebind `records_data_dir` actually relocate the file,
- the helper agrees with `RecordDataRef.resolve_data_dir()` (no parallel
  registry — single source of truth).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_records.conversation_record import ConversationRecord
from flow_sdk.fs_store import RecordDataRef, RecordType
from flow_sdk.fs_store.record import (
    get_default_records_data_root,
    record_stem,
)


# ---------------------------------------------------------------------------
# Positive
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_default_data_dir_resolves_under_records_data_root():
    """Standard records-data layout: <root>/conversation/conversation-@<id>/."""
    record_id = "aa-positive"
    expected = (
        get_default_records_data_root()
        / RecordType.CONVERSATION
        / record_stem(RecordType.CONVERSATION, record_id)
    )
    assert ConversationRecord.default_data_dir(record_id) == expected


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_default_jsonl_path_ends_with_conversation_jsonl():
    """The file inside the data dir is named `conversation.jsonl`."""
    record_id = "bb-positive"
    p = ConversationRecord.default_jsonl_path(record_id)
    assert p.name == "conversation.jsonl"
    assert p.parent.name == record_stem(RecordType.CONVERSATION, record_id)


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_default_data_dir_relocates_when_records_data_dir_changes(monkeypatch, tmp_path):
    """Rebinding the records-data root must move where the helper resolves to.

    Uses the recommended monkeypatch approach (per the helper's docstring) so
    the override is scoped to this test.
    """
    monkeypatch.setattr(
        "flow_sdk.fs_store.record.get_default_records_data_root",
        lambda: tmp_path,
    )
    record_id = "cc-relocates"
    resolved = ConversationRecord.default_data_dir(record_id)
    assert tmp_path in resolved.parents or resolved.parent.parent == tmp_path
    assert str(resolved).startswith(str(tmp_path))


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_two_different_ids_get_distinct_directories():
    """Each Conversation gets its own folder by id stem — no collisions."""
    p1 = ConversationRecord.default_data_dir("dd-id-one")
    p2 = ConversationRecord.default_data_dir("dd-id-two")
    assert p1 != p2
    assert p1.name != p2.name


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_helper_matches_record_data_ref_resolve():
    """Our helper must agree with `RecordDataRef.resolve_data_dir()`.

    Single source of truth — the helper is sugar over the registry, not a
    parallel implementation.
    """
    record_id = "ee-agrees-with-registry"
    via_helper = ConversationRecord.default_data_dir(record_id)
    via_registry = RecordDataRef(
        id=record_id, type=RecordType.CONVERSATION, format="jsonl"
    ).resolve_data_dir()
    assert via_helper == via_registry


# ---------------------------------------------------------------------------
# Negative — regressions on the bugs that motivated this change
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_path_is_never_under_system_projects_tree():
    """Conversations must never be written into the SDK source tree.

    Bug we hit: the `flowpad_assistant` system project's
    `fs_storage_mount_path` is the SDK's `system_projects/flowpad_assistant/`
    folder; the old handler joined paths from there and ended up writing
    user data into the dev tree (would be read-only in a packaged install).
    """
    p = ConversationRecord.default_jsonl_path("ff-never-system-projects")
    assert "system_projects" not in p.parts, (
        f"path {p} unexpectedly contains the system_projects segment"
    )


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_directory_name_does_not_leak_email_or_slug():
    """The folder must use the standard `conversation-@<id>` stem.

    Earlier the handler built a slug from participant emails; that leaked
    addresses into filesystem paths and broke the records-data convention.
    """
    record_id = "gg-no-slug"
    parent = ConversationRecord.default_jsonl_path(record_id).parent
    assert parent.name == f"{RecordType.CONVERSATION}-@{record_id}"
    # Sanity: the dir name MUST NOT contain '@' twice (i.e. an email) or
    # any other path-unfriendly chars beyond the canonical separator.
    assert parent.name.count("@") == 1


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_empty_id_rejected():
    """Empty id must raise — never silently bucket multiple Conversations
    into a shared `conversation-@/` folder."""
    with pytest.raises(ValueError):
        ConversationRecord.default_data_dir("")
    with pytest.raises(ValueError):
        ConversationRecord.default_jsonl_path("")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_default_data_dir_path_is_absolute():
    """Records-data paths are always absolute on real instance settings.

    Guards against a future regression where a relative path slips through
    (e.g. if `flow_home` ever resolves to `.` somewhere).
    """
    p = ConversationRecord.default_data_dir("hh-is-absolute")
    assert p.is_absolute(), f"expected absolute path, got {p}"

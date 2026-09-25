"""Subjects for the conformance kit: a folder on disk, an in-memory record source, and an
in-memory message source. Each hands the kit a FRESH source per check."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.sources import (
    CloudOrigin,
    FolderSource,
    MemoryMessages,
    MemorySource,
    MessageData,
    RecordData,
    UserProfile,
)
from flow_sdk.sources.testing import Subject


class IssueData(RecordData):
    spec_kind: ClassVar[str] = "ingest.record.issue"

    title: str
    status: str = "open"


ME = UserProfile(origin=CloudOrigin(kind="memory", namespace="chat", key="me"), name="Me")
ALICE = UserProfile(origin=CloudOrigin(kind="memory", namespace="chat", key="alice"), name="Alice", address="alice@x")
GENERAL = CloudOrigin(kind="memory", namespace="chat", key="general")


@pytest.fixture
def folder_subject(tmp_path: Path) -> Subject:
    root = tmp_path / "root"
    (root / "sub").mkdir(parents=True)
    (root / "a.txt").write_bytes(b"alpha")
    (root / "b.txt").write_bytes(b"bravo bravo")
    (root / "sub" / "c.txt").write_bytes(b"c")
    source = FolderSource.at(str(root))
    return Subject(source=lambda: FolderSource.at(str(root)), seeded=tuple(source.origin(k) for k in ("a.txt", "b.txt", "sub/c.txt")))


@pytest.fixture
def records_subject() -> Subject:
    async def seed(s: MemorySource) -> None:
        for title in ("one", "two", "three"):
            await s.create(IssueData(title=title))

    probe = MemorySource.of(IssueData, namespace="acme/issues")
    return Subject(
        source=lambda: MemorySource.of(IssueData, namespace="acme/issues"),
        seed=seed,
        seeded=tuple(probe.origin(f"{n:08d}") for n in (1, 2, 3)),
        create_data=IssueData(title="Fix login on mobile"),
    )


@pytest.fixture
def messages_subject() -> Subject:
    async def seed(s: MemoryMessages) -> None:
        for n in range(3):
            await s.receive(MessageData(text=f"m{n}", conversation=GENERAL, sender=ALICE, sent_at=datetime.now(timezone.utc)))

    probe = MemoryMessages.of(namespace="chat", sender=ME)
    return Subject(
        source=lambda: MemoryMessages.of(namespace="chat", sender=ME),
        seed=seed,
        seeded=tuple(probe.origin(f"{n:08d}") for n in (1, 2, 3)),
        conversation=GENERAL,
        recipient=ALICE,
    )

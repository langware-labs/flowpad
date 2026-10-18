"""Two-sided git-share world for the share matrix.

One instance plays both machines: ``sender/`` and ``receiver/`` are separate
directory trees sharing one bare ``file://`` remote, and the only thing that
crosses between them is the ``.flowmsg`` zip. The test DB is session-scoped, so
every case mints fresh ids and the sender's row is deleted before unpack — the
receiver then starts from what the bundle carries, nothing else.

Each phase of a share is timed into ``World.timings`` (ms), which the package
conftest aggregates into the timing report.
"""

from __future__ import annotations

import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
from flow_sdk.builtin.chart import Chart
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.schema.types import EntityType


def git(cwd: Path, *args: str, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=check)
    return r.stdout.strip()


@dataclass(frozen=True)
class Family:
    """One asset family: where it sits in a repo and how its row is made."""

    type: str
    rel_path: str  # the asset's own path inside the repo (file or folder)
    main: str  # main file, relative to rel_path ("" when rel_path is the file)

    def body(self, asset_id: str, token: str) -> str:
        if self.type == EntityType.SKILL.value:
            return f"---\nid: {asset_id}\nname: kit\ndescription: shared kit\n---\n\n# kit\n\n{token}\n"
        if self.type == EntityType.CHART.value:
            return f"---\nid: {asset_id}\nname: net\n---\n\n# net chart\n\n{token}\n"
        return f"---\nid: {asset_id}\ntitle: Shared Doc\n---\n\n# Shared Doc\n\n{token}\n"

    def main_file(self, root: Path) -> Path:
        return root / self.rel_path / self.main if self.main else root / self.rel_path

    def row(self, asset_id: str, root: Path):
        ref = str(root / self.rel_path)
        if self.type == EntityType.SKILL.value:
            return Skill(id=asset_id, name="kit", asset_ref=ref)
        if self.type == EntityType.CHART.value:
            return Chart(id=asset_id, name="net", asset_ref=ref)
        return Docs(id=asset_id, title="Shared Doc", name="Shared Doc", asset_ref=ref)

    @property
    def entity_cls(self):
        return {EntityType.SKILL.value: Skill, EntityType.CHART.value: Chart}.get(self.type, Docs)


FAMILIES = {
    "skill": Family(EntityType.SKILL.value, "tools/kit/.claude/skills/kit", "SKILL.md"),
    "markdown": Family(EntityType.MARKDOWN.value, "product/docs/shared.md", ""),
    "chart": Family(EntityType.CHART.value, "docs/network/net", "CHART.md"),
}

BRANCH = "feature/share"


@dataclass
class World:
    root: Path
    family: Family
    asset_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    token: str = field(default_factory=lambda: f"tok{uuid.uuid4().hex[:12]}")
    timings: dict[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.remote = self.root / "remote.git"
        self.sender = self.root / "sender" / "repo"
        self.receiver_home = self.root / "receiver"
        self.receiver_home.mkdir(parents=True, exist_ok=True)

    # -- timing ---------------------------------------------------------
    @asynccontextmanager
    async def phase(self, name: str):
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.timings[name] = self.timings.get(name, 0.0) + (time.perf_counter() - t0) * 1000

    # -- sender ---------------------------------------------------------
    def seed(self) -> None:
        """Bare remote + a sender clone on BRANCH with the asset committed and pushed."""
        git(self.root, "init", "--bare", "-q", "-b", "main", str(self.remote))
        self.sender.parent.mkdir(parents=True, exist_ok=True)
        git(self.root, "clone", "-q", self.remote.as_uri(), str(self.sender))
        git(self.sender, "config", "user.email", "s@t.co")
        git(self.sender, "config", "user.name", "sender")
        (self.sender / "README.md").write_text("seed\n", encoding="utf-8")
        git(self.sender, "add", "-A")
        git(self.sender, "commit", "-qm", "seed")
        git(self.sender, "push", "-q", "-u", "origin", "HEAD:main")
        git(self.sender, "checkout", "-q", "-b", BRANCH)
        self.write_asset(self.token)
        git(self.sender, "add", "-A")
        git(self.sender, "commit", "-qm", "asset")
        git(self.sender, "push", "-q", "-u", "origin", BRANCH)

    def write_asset(self, token: str) -> Path:
        f = self.family.main_file(self.sender)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(self.family.body(self.asset_id, token), encoding="utf-8")
        return f

    def sender_commit(self) -> str:
        return git(self.sender, "rev-parse", "HEAD")

    # -- receiver -------------------------------------------------------
    def receiver_clone(self, name: str = "repo", branch: str = BRANCH) -> Path:
        dst = self.receiver_home / name
        git(self.root, "clone", "-q", "--branch", branch, self.remote.as_uri(), str(dst))
        git(dst, "config", "user.email", "r@t.co")
        git(dst, "config", "user.name", "receiver")
        return dst

    # -- the share ------------------------------------------------------
    async def share(
        self,
        *,
        project_root: Path | None,
        transfer_mode: str = "git",
        install: bool = True,
        before_unpack=None,
    ):
        """Sender packs → sender row deleted → receiver unpacks + installs.

        ``before_unpack`` runs between pack and unpack (the sender keeps working,
        rewrites history, the remote goes away). Returns ``(install_response,
        received_row)``. Raises what pack raises.
        """
        key = f"{self.family.type}-{self.asset_id}"
        fm_id, conv_id = str(uuid.uuid4()), str(uuid.uuid4())
        # Both sides share one DB: a row the RECEIVER already has (an earlier
        # share) is set aside while the sender's row exists, then put back —
        # the receiver's state must be what the receiver had.
        cls = self.family.entity_cls
        held = await cls.get_one({"id": self.asset_id})
        held_dump = held.model_dump(mode="python") if held is not None else None
        held_origin = getattr(held, "origin", None)
        sender_row = self.family.row(self.asset_id, self.sender)
        await sender_row.save(notify=False)
        fm = FlowMessage(
            text="shared",
            sender_name="sender",
            conversation_id=conv_id,
            attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=key)],
        )
        fm.id = fm_id
        try:
            async with self.phase("pack"):
                zip_path = await pack_bundle(fm, dest_dir=self.root, transfer_mode=transfer_mode)
        finally:
            await sender_row.delete()
            if held_dump is not None:
                await _put_back(cls, held_dump, held_origin)

        project = None
        if project_root is not None:
            project = Project(name=f"recv-{fm_id[:8]}", fs_storage_mount_path=str(project_root))
            await project.save(notify=False)
        await Conversation(id=conv_id, title="share").save(notify=False)

        if before_unpack is not None:
            before_unpack()  # what happens on the sender's side while the message travels
        async with self.phase("unpack"):
            await unpack_bundle(zip_path, local_user_id="receiver")
        ma_id = MessageAttachment.allocate_deterministic_id(fm_id, key)
        if not install:
            return None, None
        async with self.phase("install"):
            res = await handle_attachment_install(
                ma_id,
                "project" if project else "user",
                project.id if project else None,
                someone_typeid=None,
            )
        row = await self.family.entity_cls.get_one({"id": self.asset_id})
        return res, row


async def _put_back(cls, dump: dict, origin) -> None:
    from flow_sdk.builtin.flow_message_bundle import _stamp_origins

    row = cls.model_validate(dump)
    await row.save(notify=False)
    if origin is not None:
        key = f"{row.type}-{row.id}"
        await _stamp_origins({(row.type, row.id)}, {key: origin.model_dump(mode="python")}, None)


def snapshot(repo: Path) -> dict:
    """What 'the receiver's working copy is untouched' means: HEAD, branch,
    and the exact bytes of every dirty/untracked file."""
    dirty = git(repo, "status", "--porcelain", "-uall").splitlines()
    files = {}
    for line in dirty:
        p = repo / line[3:]
        files[line[3:]] = p.read_bytes() if p.is_file() else None
    return {
        "head": git(repo, "rev-parse", "HEAD"),
        "branch": git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": files,
    }


def head_of(path: Path) -> str:
    return git(path, "rev-parse", "HEAD")

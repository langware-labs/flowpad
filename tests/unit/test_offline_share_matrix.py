"""Offline sharing: one .flowmsg carries every asset type, and the receiver gets them intact.

The whole offline path, in-process: a sender project holds one asset of each
shareable type → ``flow-message-export`` packs them all into ONE message with no
conversation → the sender side is erased (rows and files) so nothing can be
resolved from it → ``flow-message-upload`` stages the file → the message-wide
install-all files every attachment into a fresh project.

Per type it pins what "intact" means:
  * placement — the path under the receiving project is the canonical
    ``<main_subdir>/<leaf>`` the sender had, never the sender's repo layout;
  * identity — the row has the SAME id it had on the sender;
  * props — every shared field (``to_common_json``) equals the sender's;
  * locality — the row belongs to the receiving project and no field still
    names the sender's folder.

"Alive" (a real model using the asset) is ``long_tests/test_offline_share_in_docker.py``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401 — full registry
from flow_sdk.app.actions.flow_message_action import handle_export_flow_message, handle_upload_flow_message
from flow_sdk.app.actions.message_attachment_action import handle_message_install_all
from flow_sdk.builtin.flow_message_bundle import _reindex_root
from flow_sdk.builtin.mcp import Mcp
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.responses.response import ApiSuccessResponse

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

#: Row fields that are the receiver's own by construction, so they are not
#: compared across the hop (clocks restamp on install; ``name`` of a derived
#: row is compared through the spec it is derived from).
_RECEIVER_OWN = {"created_date", "updated_date", "content_digest", "indexed_at", "last_indexed_at"}


@pytest.fixture(autouse=True)
def _isolated_records_root(tmp_records_root):
    return tmp_records_root


class _Upload:
    """The one method the upload handler reads off a starlette UploadFile."""

    def __init__(self, path: Path):
        self._bytes = path.read_bytes()

    async def read(self) -> bytes:
        return self._bytes


def _seed(root: Path, tag: str) -> dict[str, Path]:
    """One asset per shareable type, each at its canonical project placement.

    Returns ``{type: path relative to root}`` — the placement the receiver must
    reproduce. The agent names the MCP through ``mcp_servers`` after indexing
    (the reference is by TypeId, so it needs the MCP's minted id).
    """
    skill = root / ".claude" / "skills" / f"skill-{tag}"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        f"---\nname: skill-{tag}\ndescription: share matrix skill\n---\n\nSay SKILL-{tag}.\n", encoding="utf-8"
    )
    (skill / "helper.py").write_text("print('helper')\n", encoding="utf-8")

    doc = root / "docs" / f"doc-{tag}.md"
    doc.parent.mkdir(parents=True)
    doc.write_text(f"---\ntitle: doc {tag}\n---\n\n# Doc\n\nThe code is DOC-{tag}.\n", encoding="utf-8")

    sub = root / ".claude" / "agents" / f"sub-{tag}.md"
    sub.parent.mkdir(parents=True)
    sub.write_text(
        f"---\nname: sub-{tag}\ndescription: share matrix subagent\n---\n\nAlways answer SUB-{tag}.\n",
        encoding="utf-8",
    )

    assets = root / "agentic-assets"
    agent = assets / "agent" / f"agent-{tag}"
    agent.mkdir(parents=True)
    (agent / "agent.json").write_text(
        json.dumps({"type": "agent", "name": f"agent-{tag}", "description": "share matrix agent", "worker_type": "claude"}),
        encoding="utf-8",
    )
    (agent / "system_prompt.md").write_text(f"Always answer AGENT-{tag}.\n", encoding="utf-8")

    mcp = assets / "mcp" / f"mcp-{tag}"
    mcp.mkdir(parents=True)
    (mcp / "mcp.json").write_text(
        json.dumps({"name": f"mcp-{tag}", "transport": "stdio", "command": "python3", "entrypoint": "server.py"}),
        encoding="utf-8",
    )
    (mcp / "server.py").write_text("# a bundled MCP server\n", encoding="utf-8")

    name = f"drv{tag}"
    drv = assets / "data_driver" / name
    drv.mkdir(parents=True)
    (drv / "data_driver.json").write_text(
        json.dumps({"schema": 1, "name": name, "ns": "sharetest", "title": "Share driver", "auth": {"credential": name, "vars": {"api_key": "SHARE_KEY"}}}),
        encoding="utf-8",
    )
    (drv / "source.py").write_text("# the driver's source\n", encoding="utf-8")

    cred = assets / "credential" / name
    cred.mkdir(parents=True)
    (cred / "credential.json").write_text(
        json.dumps({"name": name, "title": "Share credential", "schema": 2, "vars": {"SHARE_KEY": {"label": "Key"}}}),
        encoding="utf-8",
    )

    return {
        "skill": skill.relative_to(root),
        "markdown": doc.relative_to(root),
        "subagent": sub.relative_to(root),
        "agent": agent.relative_to(root),
        "mcp": mcp.relative_to(root),
        "data_driver": drv.relative_to(root),
        "credential": cred.relative_to(root),
    }


async def _row_at(type_name: str, root: Path, rel: Path):
    """The indexed row whose asset lives at ``root/rel`` (file or folder form)."""
    cls = SchemaRegistry.get_entity_cls(type_name)
    target = (root / rel).resolve()
    for row in await cls.get_all({}):
        ref = str(getattr(row, "asset_ref", "") or "")
        if not ref:
            continue
        p = Path(ref).resolve()
        if p == target or p.parent == target:
            return row
    return None


async def _project(root: Path, name: str) -> Project:
    root.mkdir(parents=True, exist_ok=True)
    project = Project(name=name, fs_storage_mount_path=str(root))
    await project.save(notify=False)
    return project


def _shared(row) -> dict:
    return {k: v for k, v in row.to_common_json().items() if k not in _RECEIVER_OWN}


async def _export(refs: list[str], tmp_path: Path) -> Path:
    resp = await handle_export_flow_message({"text": "offline package", "asset_references": refs})
    assert not isinstance(resp, dict) and getattr(resp, "path", None), getattr(resp, "message", resp)
    out = tmp_path / "package.flowmsg"
    shutil.copy(resp.path, out)
    return out


@pytest.mark.long  # 1.64s — seven real asset folders indexed twice
async def test_one_message_carries_every_type_intact(tmp_path):
    tag = uuid.uuid4().hex[:8]
    sender_root = tmp_path / "sender"
    sender = await _project(sender_root, f"sender-{tag}")
    placement = _seed(sender_root, tag)
    await _reindex_root(sender_root, RecordType.REAL_PROJECT_CWD, project_id=sender.id)

    sent: dict[str, object] = {}
    for type_name, rel in placement.items():
        row = await _row_at(type_name, sender_root, rel)
        assert row is not None, f"sender did not index its {type_name} at {rel}"
        sent[type_name] = row
    sent_props = {t: _shared(r) for t, r in sent.items()}

    package = await _export([str(r.typeid) for r in sent.values()], tmp_path)

    # Erase the sender: nothing on the receiver may resolve through it.
    for row in sent.values():
        await row.destroy()
    shutil.rmtree(sender_root)

    receiver_root = tmp_path / "receiver"
    receiver = await _project(receiver_root, f"receiver-{tag}")
    up = await handle_upload_flow_message(_Upload(package), overwrite=False)
    assert isinstance(up, ApiSuccessResponse), getattr(up, "message", up)
    staged = up.data["attachments"]
    assert sorted(a["asset_type"] for a in staged) == sorted(placement), staged
    assert {a["asset_id"] for a in staged} == {r.id for r in sent.values()}, "the file renamed an asset"
    # The review rail names each attachment after the asset itself — not after
    # whichever *.md the folder happens to carry (an agent read as `system_prompt`).
    named = {a["asset_type"]: a["name"] for a in staged}
    for type_name in ("skill", "subagent", "agent", "mcp", "data_driver", "credential"):
        assert named[type_name] == sent[type_name].name, f"{type_name} staged as {named[type_name]!r}"

    res = await handle_message_install_all(up.data["message_id"], receiver.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert not res.data["failed"], res.data["errors"]

    for type_name, rel in placement.items():
        assert (receiver_root / rel).exists(), f"{type_name} not at its canonical place {rel}"
        got = await _row_at(type_name, receiver_root, rel)
        assert got is not None, f"receiver did not index {type_name}"
        assert got.id == sent[type_name].id, f"{type_name} changed id"
        assert got.project_id == receiver.id, f"{type_name} not filed under the receiving project"
        assert _shared(got) == sent_props[type_name], f"{type_name} props changed across the hop"
        assert str(sender_root) not in json.dumps(got.model_dump(mode="json")), f"{type_name} still names the sender"


async def test_export_ignores_the_senders_repo_layout(tmp_path):
    """An asset living inside a git repo still ships at ``<main_subdir>/<leaf>``:
    the receiver has no clone to mirror, so the repo's folders must not come along."""
    tag = uuid.uuid4().hex[:8]
    repo = tmp_path / "repo"
    nested = repo / "deep" / "inside"
    project = await _project(nested, f"nested-{tag}")
    skill = nested / ".claude" / "skills" / f"skill-{tag}"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(f"---\nname: skill-{tag}\ndescription: d\n---\n\nbody\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", "https://example.com/r.git"], check=True)
    await _reindex_root(nested, RecordType.REAL_PROJECT_CWD, project_id=project.id)
    row = await _row_at("skill", nested, skill.relative_to(nested))
    assert row is not None

    import zipfile

    package = await _export([str(row.typeid)], tmp_path)
    names = zipfile.ZipFile(package).namelist()
    entry = f"attachment/skill-{row.id}/"
    assert f"{entry}.claude/skills/skill-{tag}/SKILL.md" in names, names
    assert not any(n.startswith(entry + "deep/") for n in names), names
    assert "fs_origins.json" not in names


async def test_export_refuses_a_reference_that_names_nothing():
    missing = f"skill-{uuid.uuid4()}"
    resp = await handle_export_flow_message({"asset_references": [missing]})
    assert getattr(resp, "status_code", None) == 404 and resp.data["missing"] == [missing]


async def test_mcp_does_not_ship_the_senders_path():
    body = Mcp(name="m", asset_ref="/sender/home/proj/agentic-assets/mcp/m").to_common_json()
    assert "asset_ref" not in body


async def test_a_row_that_lags_its_file_ships_what_the_file_says(tmp_path):
    """The sender edits ``agent.json`` after its last index, so its row still says
    the old thing. The package must carry what the FILE says — the receiver's
    overlay would otherwise put the stale value back over the file it indexed
    (an agent arrived with ``mcp_servers: []`` beside a file naming its MCP)."""
    tag = uuid.uuid4().hex[:8]
    sender_root = tmp_path / "sender"
    sender = await _project(sender_root, f"lag-{tag}")
    agent_dir = sender_root / "agentic-assets" / "agent" / f"agent-{tag}"
    agent_dir.mkdir(parents=True)
    manifest = agent_dir / "agent.json"
    manifest.write_text(json.dumps({"type": "agent", "name": f"agent-{tag}", "worker_type": "claude"}), encoding="utf-8")
    (agent_dir / "system_prompt.md").write_text("hi\n", encoding="utf-8")
    await _reindex_root(sender_root, RecordType.REAL_PROJECT_CWD, project_id=sender.id)
    row = await _row_at("agent", sender_root, agent_dir.relative_to(sender_root))

    # Edited on disk after the index: the row still has no skills.
    wanted = ["skill-11111111-1111-4111-8111-111111111111"]
    body = json.loads(manifest.read_text(encoding="utf-8"))
    manifest.write_text(json.dumps({**body, "skills": wanted}), encoding="utf-8")
    assert not (await type(row).get_one({"id": row.id})).skills

    package = await _export([str(row.typeid)], tmp_path)
    await row.destroy()
    shutil.rmtree(sender_root)

    receiver_root = tmp_path / "receiver"
    receiver = await _project(receiver_root, f"lag-rx-{tag}")
    up = await handle_upload_flow_message(_Upload(package), overwrite=False)
    res = await handle_message_install_all(up.data["message_id"], receiver.id)
    assert isinstance(res, ApiSuccessResponse) and not res.data["failed"], res

    got = await _row_at("agent", receiver_root, agent_dir.relative_to(sender_root))
    assert [str(s) for s in got.skills] == wanted, f"the stale row won over the file: {got.skills}"
    import zipfile

    rel = agent_dir.relative_to(sender_root) / "agent.json"
    shipped = zipfile.ZipFile(package).read(f"attachment/agent-{row.id}/{rel.as_posix()}")
    assert (receiver_root / rel).read_bytes() == shipped, "install rewrote the file it received"
    installed = json.loads((receiver_root / agent_dir.relative_to(sender_root) / "agent.json").read_text(encoding="utf-8"))
    assert installed.get("skills") == wanted, f"the installed file lost its value: {installed}"

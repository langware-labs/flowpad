import hashlib
import struct
from pathlib import Path

from flow_sdk.builtin.agent import Agent
from flow_sdk.fs_store.fs_ref import FSRef
from tests.unit.agent._parse import parse_agent_markdown
from flow_sdk.schema.type_info.agent_type_info import AGENT

Q_ROOT = Path(__file__).parents[3] / "agentic-assets" / "agent" / "q"
Q_SKILL_ID = "skill-ae32bd1d-2fca-50c2-bf33-fa24a06aad61"
Q_ID = "004f3ab7-d33b-48c0-ae0e-6e61e181a343"
Q_AVATAR_SHA256 = "438b5806edae1c9eaf1da9950a9735d2a11af7aafb84e445338f2a452635e8f8"


def test_q_bundle_is_a_valid_agent_with_its_qa_skill() -> None:
    main_ref = FSRef(Q_ROOT / "agent.md", record_type="agent", read_only=True)
    fields = parse_agent_markdown(main_ref._path.read_text(encoding="utf-8"), "q")
    q = Agent(id=AGENT.to_type_info().mint_entity_id(main_ref), **fields)

    assert q.id == Q_ID
    assert q.name == "Q"
    assert q.title == "QA manager"
    assert q.avatar == "./avatar.png"
    assert q.enabled is True
    assert [str(skill) for skill in q.skills] == [Q_SKILL_ID]
    assert "use the `e2e-qa` skill" in q.system_prompt


def test_q_bundle_contains_the_supplied_avatar() -> None:
    image = (Q_ROOT / "avatar.png").read_bytes()

    assert image.startswith(b"\x89PNG\r\n\x1a\n")
    assert struct.unpack(">II", image[16:24]) == (1254, 1254)
    assert hashlib.sha256(image).hexdigest() == Q_AVATAR_SHA256

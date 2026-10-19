"""A Write/Edit that leaves a skill header unparseable is handed back to the agent."""

import json
import subprocess
import sys

import pytest

from flow_sdk.assets.frontmatter_check import check_hook_payload, frontmatter_error


def _payload(path, tool="Write"):
    return {"tool_name": tool, "tool_input": {"file_path": str(path)}}


def _skill(tmp_path, header):
    path = tmp_path / ".claude" / "skills" / "probe" / "SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text(f"---\n{header}\n---\n\nbody\n", encoding="utf-8")
    return path


@pytest.mark.parametrize(
    "header",
    [
        'name: probe\ndescription: Use when "what\'s new: leads"',  # unquoted ": "
        "name: probe\ndescription: 'brief my day or today's briefs'",  # apostrophe in single quotes
    ],
)
def test_broken_header_blocks(tmp_path, header):
    path = _skill(tmp_path, header)
    assert str(path) in check_hook_payload(_payload(path, "Edit"))


def test_valid_header_is_silent(tmp_path):
    path = _skill(tmp_path, "name: probe\ndescription: \"what's new: leads\"")
    assert check_hook_payload(_payload(path)) is None


def test_file_outside_asset_folders_is_ignored(tmp_path):
    other = tmp_path / "notes.md"
    other.write_text("---\na: b: c\n---\n", encoding="utf-8")
    assert check_hook_payload(_payload(other)) is None


def test_non_write_tool_is_ignored(tmp_path):
    path = _skill(tmp_path, "description: a: b")
    assert check_hook_payload(_payload(path, "Read")) is None


def test_no_frontmatter_is_fine():
    assert frontmatter_error("# just a body\n") is None


def test_unclosed_header_errors():
    assert frontmatter_error("---\nname: x\n") is not None


def test_module_entry_prints_claude_block(tmp_path):
    path = _skill(tmp_path, "description: a: b")
    out = subprocess.run(
        [sys.executable, "-m", "flow_sdk.assets.frontmatter_check"],
        input=json.dumps(_payload(path)), capture_output=True, text=True, check=True,
    ).stdout
    assert json.loads(out)["decision"] == "block"

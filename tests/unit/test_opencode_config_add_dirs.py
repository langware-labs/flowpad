"""The generated ``opencode.json`` is opencode's ONLY delivery channel.

OpenCode has no ``--add-dir``, so an extra mounted root (the Flowpad Assistant,
a project's context folders, ``additional_dirs``) reaches the worker through
this config or not at all. It previously reached it not at all: the roots were
carried to the argv builder and dropped, which is why a worker launched with
``load_flowpad_assistant`` reported it had no ``web-app-builder`` skill.
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import (
    add_dir_contributions,
    build_config,
    config_for_assets_dir,
)


def _root(tmp_path: Path, name: str, *, agents_md: bool = False) -> Path:
    root = tmp_path / name
    (root / ".claude" / "skills" / "a-skill").mkdir(parents=True)
    (root / ".claude" / "skills" / "a-skill" / "SKILL.md").write_text("---\nname: a-skill\n---\n")
    if agents_md:
        (root / "AGENTS.md").write_text("root instructions\n")
    return root


def test_the_skills_container_is_listed_not_the_root(tmp_path):
    """Measured against opencode 1.18.25: a config listing a ROOT whose skills
    live in ``<root>/.claude/skills/<name>/`` finds NOTHING — the recursive scan
    does not descend into dot-directories. Listing the container finds them all."""
    root = _root(tmp_path, "assistant")
    instructions, skills = add_dir_contributions([root])
    assert skills == [str(root / ".claude" / "skills")]
    assert str(root) not in skills
    assert instructions == []


def test_every_harness_container_in_one_root_is_listed(tmp_path):
    """One mounted root may serve several vendors."""
    root = tmp_path / "multi"
    for relative in (".opencode/skills", ".claude/skills", ".github/skills", "skills"):
        (root / relative / "s").mkdir(parents=True)
        (root / relative / "s" / "SKILL.md").write_text("---\nname: s\n---\n")
    _, skills = add_dir_contributions([root])
    assert skills == [
        str(root / ".opencode" / "skills"),
        str(root / ".claude" / "skills"),
        str(root / ".github" / "skills"),
        str(root / "skills"),
    ]


def test_a_root_that_is_itself_a_skills_container_is_listed(tmp_path):
    root = tmp_path / "bare"
    (root / "a-skill").mkdir(parents=True)
    (root / "a-skill" / "SKILL.md").write_text("---\nname: a-skill\n---\n")
    _, skills = add_dir_contributions([root])
    assert skills == [str(root)]


def test_add_dir_agents_md_is_listed_only_when_it_exists(tmp_path):
    """opencode reads ``instructions`` entries eagerly — a listed file that is
    missing aborts the whole turn with BadResource before any model call."""
    with_md = _root(tmp_path, "with", agents_md=True)
    without_md = _root(tmp_path, "without")
    instructions, skills = add_dir_contributions([with_md, without_md])
    assert instructions == [str(with_md / "AGENTS.md")]
    assert skills == [
        str(with_md / ".claude" / "skills"),
        str(without_md / ".claude" / "skills"),
    ]


def test_add_dir_skips_paths_that_are_not_directories(tmp_path):
    assert add_dir_contributions([tmp_path / "nope", None]) == ([], [])


def test_config_carries_add_dirs_alongside_the_process_assets(tmp_path):
    root = _root(tmp_path, "assistant", agents_md=True)
    assets = tmp_path / "assets"
    (assets / ".opencode" / "skills").mkdir(parents=True)
    (assets / "AGENTS.md").write_text("process instructions\n")

    path = config_for_assets_dir("proc-1", assets, None, [root])

    assert path is not None
    config = json.loads(path.read_text())
    assert str(assets / ".opencode" / "skills") in config["skills"]["paths"]
    assert str(root / ".claude" / "skills") in config["skills"]["paths"]
    assert config["instructions"] == [str(assets / "AGENTS.md"), str(root / "AGENTS.md")]


def test_add_dirs_alone_still_warrant_a_config(tmp_path):
    """A process with an assistant mount and no instruction assets of its own
    must still get a config — otherwise OPENCODE_CONFIG is never set."""
    root = _root(tmp_path, "assistant")
    path = config_for_assets_dir("proc-2", None, None, [root])
    assert path is not None
    assert json.loads(path.read_text())["skills"]["paths"] == [str(root / ".claude" / "skills")]


def test_nothing_to_say_writes_no_config(tmp_path):
    assert config_for_assets_dir("proc-3", None, None, []) is None


def test_build_config_stays_pure():
    assert build_config() == {"$schema": "https://opencode.ai/config.json"}


def test_the_assets_dir_is_not_listed_twice(tmp_path):
    """``resolved_add_dirs`` already contains the process assets dir, so the
    caller passes it on both arguments — the entry must appear once."""
    assets = tmp_path / "assets"
    (assets / ".opencode" / "skills").mkdir(parents=True)
    (assets / "AGENTS.md").write_text("process instructions\n")

    path = config_for_assets_dir("proc-dup", assets, None, [assets, _root(tmp_path, "extra")])

    config = json.loads(path.read_text())
    paths = config["skills"]["paths"]
    assert paths.count(str(assets / ".opencode" / "skills")) == 1
    assert config["instructions"] == [str(assets / "AGENTS.md")]


def test_an_identical_regeneration_does_not_rewrite_the_file(tmp_path):
    """The shared prompt path regenerates every turn; identical bytes must not
    churn the mtime under a worker that reads the file at spawn."""
    root = _root(tmp_path, "assistant")
    first = config_for_assets_dir("proc-stable", None, None, [root])
    stamp = first.stat().st_mtime_ns
    second = config_for_assets_dir("proc-stable", None, None, [root])
    assert second == first
    assert second.stat().st_mtime_ns == stamp

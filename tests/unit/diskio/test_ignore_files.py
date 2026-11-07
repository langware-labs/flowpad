"""Every ignore file is matched exactly as git matches it, and git itself is the oracle.

On one tree with tricky rules in nested files, the walk (each backend) keeps exactly the files
``git ls-files`` keeps, for ``.gitignore`` and for ``.flowignore`` alike. Then what git cannot
judge: ``.flowignore`` decides before ``.gitignore`` and the ``.claude/`` force-include, and the
``.flowignore`` files above the walked root apply inside it.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from flow_sdk.diskio.contract import Scanner, ScanRequest, ScanRoot, WalkEntry
from flow_sdk.diskio.python.tree_walker import walk_policy
from tests.unit.diskio._backends import backends, drain, touch


@pytest.fixture(params=backends(Scanner))
def scanner(request):
    return request.param()


def walk(scanner, root: Path) -> dict[str, WalkEntry]:
    request = ScanRequest(roots=(ScanRoot(path=str(root), kind="real_project_cwd"),),
                          policy=walk_policy(gitignore=True, denylist=True), specs=())
    body, _end = drain(scanner.scan(request))
    return {os.path.relpath(e.dir, root): e for e in body if isinstance(e, WalkEntry)}


def kept_files(scanner, root: Path) -> set[str]:
    return {os.path.normpath(os.path.join(d, f)) for d, e in walk(scanner, root).items() for f in e.files}


# Each folder's rules. ``sub/local`` is excluded by its parent, so its own file is never read.
RULES = {
    "": "# a comment\n*.log\n!keep.log\n/top.txt\ndocs/*.tmp\na/**/b\nab**/c\n[!x]y.cfg\n"
        "[[:digit:]]*.dat\n\\#hash\ntrail   \nout/\n*.md\n",
    "sub": "!keep.md\r\n!out/\nlocal/\n**/gen/**\n",
    "sub/local": "!inner.txt\n",
    "sub/deeper": "!*.log\n",
}
FILES = [
    "a.log", "keep.log", "top.txt", "sub/top.txt", "docs/x.tmp", "docs/deep/x.tmp", "a/b", "a/x/y/b",
    "abq/c", "ab/x/c", "zy.cfg", "xy.cfg", "1.dat", "x.dat", "#hash", "trail", "out/o.txt",
    "sub/out/o.txt", "sub/a.md", "sub/keep.md", "sub/local/inner.txt", "sub/deeper/b.md",
    "sub/deeper/d.log", "sub/gen/g.txt", "plain.txt",
]


@pytest.mark.skipif(shutil.which("git") is None, reason="git is the oracle")
@pytest.mark.parametrize("name", [".gitignore", ".flowignore"])
def test_the_walk_keeps_exactly_what_git_keeps(scanner, tmp_path, name):
    for folder, text in RULES.items():
        touch(tmp_path / folder / name, text)
    for rel in FILES:
        touch(tmp_path / rel)
    git = ["git", "-c", "core.ignorecase=false", "ls-files", "-z", "-o"]
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    every = subprocess.run(git, cwd=tmp_path, capture_output=True, check=True).stdout.decode().split("\0")
    ignored = subprocess.run([*git, "-i", f"--exclude-per-directory={name}"],
                             cwd=tmp_path, capture_output=True, check=True).stdout.decode().split("\0")
    git_keeps = {os.path.normpath(p) for p in set(every) - set(ignored) if p}

    assert kept_files(scanner, tmp_path) == git_keeps
    # The rules bite both ways: a nested "!" re-includes, an excluded folder stays excluded,
    # and a "**" right after a literal is one star.
    assert {"sub/keep.md", "sub/deeper/d.log", "sub/out/o.txt", "ab/x/c"} <= git_keeps
    assert not {"sub/a.md", "sub/local/inner.txt", "abq/c", "out/o.txt"} & git_keeps


def test_a_flowignore_decides_before_the_gitignore_and_the_force_include(scanner, tmp_path):
    touch(tmp_path / ".gitignore", "reports/\n.claude/\n")
    touch(tmp_path / ".flowignore", "!reports/\n.claude/skills/old/\n*.secret\n")
    touch(tmp_path / "reports" / "r.md")
    touch(tmp_path / ".claude" / "skills" / "old" / "SKILL.md")
    touch(tmp_path / ".claude" / "skills" / "new" / "SKILL.md")
    touch(tmp_path / "x.secret")
    walked = walk(scanner, tmp_path)
    assert walked["reports"].files == ("r.md",)
    assert walked[os.path.join(".claude", "skills")].subdirs == ("new",)
    assert walked["."].files == (".flowignore", ".gitignore")


def test_the_flowignore_files_above_the_root_apply_inside_it(scanner, tmp_path):
    touch(tmp_path / ".flowignore", "proj/drop/\nother/\n")
    touch(tmp_path / "proj" / "drop" / "d.md")
    touch(tmp_path / "proj" / "keep" / "k.md")
    touch(tmp_path / "other" / ".flowignore", "!*\n")  # never read: its folder is excluded
    touch(tmp_path / "other" / "sub" / "o.md")
    assert walk(scanner, tmp_path / "proj")["."].subdirs == ("keep",)
    (only,) = walk(scanner, tmp_path / "other").values()
    assert only.subdirs == () and only.files == ()


def test_a_relative_root_obeys_its_flowignore(scanner, tmp_path, monkeypatch):
    touch(tmp_path / "proj" / ".flowignore", "secret/\n")
    touch(tmp_path / "proj" / "secret" / "s.md")
    touch(tmp_path / "proj" / "open" / "o.md")
    monkeypatch.chdir(tmp_path)
    assert walk(scanner, Path("proj"))["."].subdirs == ("open",)

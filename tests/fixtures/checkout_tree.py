"""A small tree shaped like a real checkout, for walker tests.

Every asset test in the repo builds a handful of files under ``tmp_path``, so a
walker that forgets to prune reads as "a few milliseconds slower" there and as
"minutes per request" on a developer's checkout with ``ui/node_modules``. This
fixture puts the vendor, build, virtualenv and gitignored trees a checkout
really has next to the assets that must still be found, and declares which is
which once, so a test asserts the split instead of restating paths.

No pytest constructs live here — the builder is a plain function taking a base
directory, so any tier can use it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.api.api_types.identifier import mint_uuid

#: Directories a real checkout carries that no walker may enter. Each holds a
#: decoy skill so a walker that descends it produces a visible extra asset
#: rather than just wasted time.
HIDDEN_DIRS = (
    "ui/node_modules/left-pad",          # hardcoded denylist
    ".venv/lib/site-packages/pkg",       # dot-prefixed AND denylisted
    "dist/bundle",                       # denylisted build output
    "generated/protos",                  # root .gitignore
    "src/nested/cache/tmp",              # nested .gitignore in src/nested
)

#: Where a checkout's real assets live; all of these must be found.
VISIBLE_DIRS = (
    "src/tools/deploy",                  # a skill folder in the source tree
    ".claude/skills/kept",               # force-included even when .claude/ is gitignored
    "docs/runbooks/oncall",              # ordinary content dir
)

#: Filler files per decoy dir, so ignored trees are wider than one entry.
FILLER = ("package.json", "README.md", "index.js", "types.d.ts")


@dataclass(frozen=True)
class CheckoutTree:
    root: Path
    visible: tuple[Path, ...]
    hidden: tuple[Path, ...]
    skill_ids: dict[Path, str] = field(default_factory=dict)


def _skill(path: Path, ids: dict[Path, str]) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    identity = mint_uuid()
    (path / "SKILL.md").write_text(
        f"---\nid: {identity}\nname: {path.name}\ndescription: {path.name}\n---\nInstructions.\n",
        encoding="utf-8",
    )
    ids[path] = identity
    return path


def build_checkout_tree(root: Path) -> CheckoutTree:
    """Lay the checkout down under ``root`` and return the visible/hidden split."""
    root.mkdir(parents=True, exist_ok=True)
    (root / ".gitignore").write_text("generated/\n.claude/\n*.log\n", encoding="utf-8")
    (root / "src" / "nested").mkdir(parents=True, exist_ok=True)
    (root / "src" / "nested" / ".gitignore").write_text("cache/\n", encoding="utf-8")
    (root / "src" / "nested" / "keep.py").write_text("x = 1\n", encoding="utf-8")
    (root / "server.log").write_text("noise\n", encoding="utf-8")
    ids: dict[Path, str] = {}
    hidden = []
    for rel in HIDDEN_DIRS:
        path = _skill(root / rel, ids)
        for name in FILLER:
            (path / name).write_text("{}\n", encoding="utf-8")
        hidden.append(path)
    visible = [_skill(root / rel, ids) for rel in VISIBLE_DIRS]
    return CheckoutTree(root=root, visible=tuple(visible), hidden=tuple(hidden), skill_ids=ids)

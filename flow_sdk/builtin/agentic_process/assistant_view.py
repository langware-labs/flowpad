"""The Flowpad Assistant as one agent sees it: every skill, or only the ones it picked.

A worker discovers the assistant's skills by mounting its project root (``--add-dir``); every
harness reads ``<mount>/.claude/skills`` (copilot and opencode through the same mount). So an
agent that wants SOME skills mounts a VIEW instead of the root: a folder that links every entry
of the root, except that its ``.claude/skills`` links only the chosen skills. Everything else the
worker reads through the mount (docs, references, agents) stays where it was.

A view is keyed by the install's root and the chosen names, built once, and reused by every
process that asks for the same set.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path

SKILLS = Path(".claude") / "skills"


def _assistant_root() -> Path:
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

    return flowpad_assistant_project_root()


def _views_root() -> Path:
    from flow_sdk import config  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(config.FLOWPAD_TEMP_DIR) / get_instance_settings().instance_name / "assistant-views"


def skill_catalog() -> list[dict[str, str]]:
    """Every skill the assistant ships, as ``{"name", "description"}`` — what an agent may pick from.

    ``name`` is the skill's folder name: what ``assistant_skills`` lists and what the view links.
    """
    from flow_sdk.assets.types.skill import folder_is_skill, parse_skill_yaml_from_dir  # noqa: PLC0415

    skills_dir = _assistant_root() / SKILLS
    catalog = []
    for folder in sorted(skills_dir.iterdir()) if skills_dir.is_dir() else []:
        if folder.is_dir() and folder_is_skill(folder):
            description = parse_skill_yaml_from_dir(folder).get("description") or ""
            catalog.append({"name": folder.name, "description": str(description).strip()})
    return catalog


def _link(target: Path, link: Path) -> None:
    """Link ``link`` to ``target``; copy where the OS refuses symlinks (Windows without Developer Mode)."""
    try:
        os.symlink(target, link, target_is_directory=target.is_dir())
    except OSError:
        if target.is_dir():
            shutil.copytree(target, link, symlinks=True)
        else:
            shutil.copy2(target, link)


def _build(root: Path, skills: list[str], view: Path) -> None:
    view.mkdir(parents=True)
    for entry in root.iterdir():
        if entry.name != ".claude":
            _link(entry, view / entry.name)
    claude = view / ".claude"
    claude.mkdir()
    for entry in (root / ".claude").iterdir():
        if entry.name != "skills":
            _link(entry, claude / entry.name)
    (claude / "skills").mkdir()
    for name in skills:
        source = root / SKILLS / name
        if source.is_dir():
            _link(source, claude / "skills" / name)


def including(skills: list[str] | None, name: str) -> list[str] | None:
    """``skills`` with ``name`` added — for a launch that cannot run without that skill. ``None`` stays all."""
    return None if skills is None else sorted({*skills, name})


def is_assistant_view(path: str | Path) -> bool:
    """Whether ``path`` is a view of the assistant — the assistant, mounted with fewer skills."""
    try:
        return Path(path).expanduser().resolve().parent == _views_root().resolve()
    except OSError:
        return False


def assistant_mount(skills: list[str] | None) -> Path:
    """The folder to mount as the assistant: its root for every skill (``None``), else a view of ``skills``."""
    root = _assistant_root()
    if skills is None:
        return root
    chosen = sorted(set(skills))
    key = hashlib.sha256("\n".join([str(root.resolve()), *chosen]).encode()).hexdigest()[:16]
    view = _views_root() / key
    if view.is_dir():
        return view
    # Built aside and renamed into place, so a process racing on the same set never mounts a half view.
    staging = view.with_name(f"{key}.{os.getpid()}.tmp")
    shutil.rmtree(staging, ignore_errors=True)
    _build(root, chosen, staging)
    try:
        staging.rename(view)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
    return view

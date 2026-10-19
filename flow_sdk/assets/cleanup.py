"""Bounded filesystem inputs for asset-cleanup classification."""

from __future__ import annotations

from pathlib import Path

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec import DataSpec


class CleanupKind(StrEnum):
    """Kinds in the existing cleanup-agent report contract."""

    SKILL = "skill"
    SUBAGENT = "agent"
    WORKFLOW = "workflow"
    COMMAND = "command"
    PLAN = "plan"
    SETTINGS_BACKUP = "settings_backup"


class CleanupCandidate(DataSpec):
    path: str
    kind: CleanupKind
    name: str
    root: str
    content: str | None = None
    modified_at: float | None = None
    live_settings_modified_at: float | None = None


def collect_asset_inventory(roots: list[str | Path]) -> list[CleanupCandidate]:
    """Return the complete file-asset inventory for ``roots``.

    Only the asset locations in the cleanup contract are visited. Text is
    supplied with each candidate so classification needs no filesystem tools;
    settings backups carry timestamps instead because their age relative to
    the live settings file is the relevant signal and their content may hold
    secrets.
    """
    candidates: dict[str, CleanupCandidate] = {}
    for raw_root in roots:
        root = Path(raw_root).expanduser().resolve()
        claude_dir = root / ".claude"

        skills_dir = claude_dir / "skills"
        if skills_dir.is_dir():
            for folder in skills_dir.iterdir():
                if not folder.is_dir():
                    continue
                main = next(
                    (folder / name for name in ("SKILL.md", "skill.yaml", "skill.yml") if (folder / name).is_file()),
                    None,
                )
                if main is not None:
                    _add_text_candidate(candidates, main, CleanupKind.SKILL, folder.name, root)

        for kind, dirname, suffixes in (
            (CleanupKind.SUBAGENT, "agents", (".md",)),
            (CleanupKind.WORKFLOW, "workflows", (".md", ".js")),
            (CleanupKind.COMMAND, "commands", (".md",)),
            (CleanupKind.PLAN, "plans", (".md",)),
        ):
            folder = claude_dir / dirname
            if not folder.is_dir():
                continue
            for path in folder.iterdir():
                if path.is_file() and path.suffix in suffixes:
                    _add_text_candidate(candidates, path, kind, path.stem, root)

        live_settings = claude_dir / "settings.json"
        live_mtime = live_settings.stat().st_mtime if live_settings.is_file() else None
        for pattern in ("settings.json.bak*", "settings.json.backup"):
            for path in claude_dir.glob(pattern):
                if not path.is_file():
                    continue
                candidates[str(path)] = CleanupCandidate(
                    path=str(path), kind=CleanupKind.SETTINGS_BACKUP, name=path.name,
                    root=str(root), modified_at=path.stat().st_mtime,
                    live_settings_modified_at=live_mtime,
                )

    return [candidates[path] for path in sorted(candidates)]


def _add_text_candidate(
    candidates: dict[str, CleanupCandidate], path: Path, kind: CleanupKind, name: str, root: Path
) -> None:
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        content = f"[unreadable: {exc}]"
    candidates[str(path)] = CleanupCandidate(path=str(path), kind=kind, name=name, root=str(root), content=content)

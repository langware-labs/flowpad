"""Local web-app discovery helpers for the agent-facing ``flow app`` CLI.

The scanner is deliberately heuristic and conservative: it finds app roots the
agent could reasonably start from the current checkout, but avoids dependency
and build output directories.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
}

GENERIC_QUERY_TERMS = {
    "a",
    "an",
    "app",
    "application",
    "display",
    "existing",
    "launch",
    "open",
    "please",
    "preview",
    "run",
    "show",
    "start",
    "the",
    "ui",
    "web",
    "website",
}

FRAMEWORK_DEFAULT_PORTS = {
    "next": 3000,
    "vite": 5173,
    "react-scripts": 3000,
    "astro": 4321,
    "nuxt": 3000,
    "sveltekit": 5173,
    "angular": 4200,
}


@dataclass(frozen=True)
class WebAppCandidate:
    name: str
    path: str
    kind: str
    start_cmd: str
    port: int | None
    health: str
    score: int
    evidence: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def discover_webapps(root: str | Path, query: str = "", max_depth: int = 6) -> list[WebAppCandidate]:
    """Find likely web apps below ``root``, ordered by best match first."""
    root_path = Path(root).expanduser().resolve()
    if not root_path.exists() or not root_path.is_dir():
        return []

    query_terms = _query_terms(query)
    candidates: list[WebAppCandidate] = []
    package_roots: set[Path] = set()

    for package_json in _iter_files(root_path, "package.json", max_depth=max_depth):
        candidate = _candidate_from_package(package_json, root_path, query_terms)
        if candidate is not None:
            candidates.append(candidate)
            package_roots.add(package_json.parent.resolve())

    for index_html in _iter_files(root_path, "index.html", max_depth=max_depth):
        static_root = index_html.parent.resolve()
        if _inside_any(static_root, package_roots):
            continue
        candidate = _candidate_from_static(index_html, root_path, query_terms)
        if candidate is not None:
            candidates.append(candidate)

    return sorted(candidates, key=lambda c: (c.score, -_path_depth(root_path, Path(c.path))), reverse=True)


def best_webapp(root: str | Path, query: str = "", max_depth: int = 6) -> WebAppCandidate | None:
    candidates = discover_webapps(root, query=query, max_depth=max_depth)
    return candidates[0] if candidates else None


def _iter_files(root: Path, filename: str, *, max_depth: int) -> Iterable[Path]:
    def walk(directory: Path, depth: int) -> Iterable[Path]:
        if depth > max_depth:
            return
        try:
            entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return
        for entry in entries:
            if entry.is_dir():
                if entry.name in EXCLUDED_DIRS:
                    continue
                yield from walk(entry, depth + 1)
            elif entry.name == filename:
                yield entry

    yield from walk(root, 0)


def _candidate_from_package(package_json: Path, root: Path, query_terms: set[str]) -> WebAppCandidate | None:
    try:
        pkg = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(pkg, dict):
        return None

    scripts = pkg.get("scripts") if isinstance(pkg.get("scripts"), dict) else {}
    deps = _dependency_names(pkg)
    framework = _detect_framework(deps, scripts)
    start_script = _pick_start_script(scripts, framework)
    if framework is None and start_script is None:
        return None

    app_dir = package_json.parent.resolve()
    script_name = start_script or "dev"
    start_cmd = _package_manager_command(app_dir, script_name)
    script_value = str(scripts.get(script_name, ""))
    port = _parse_port(script_value) or (FRAMEWORK_DEFAULT_PORTS.get(framework or "") if framework else None)
    name = _candidate_name(pkg.get("name"), app_dir, root)
    evidence = ["package.json"]
    if framework:
        evidence.append(framework)
    if script_name in scripts:
        evidence.append(f"script:{script_name}")

    score = 100
    if framework:
        score += 25
    if script_name == "dev":
        score += 15
    score += _path_score(root, app_dir)
    score += _query_score(
        query_terms, [name, str(app_dir.relative_to(root)) if _is_relative_to(app_dir, root) else str(app_dir)]
    )
    score -= _path_depth(root, app_dir)

    return WebAppCandidate(
        name=name,
        path=str(app_dir),
        kind=framework or "node",
        start_cmd=start_cmd,
        port=port,
        health="/",
        score=score,
        evidence=evidence,
    )


def _candidate_from_static(index_html: Path, root: Path, query_terms: set[str]) -> WebAppCandidate | None:
    app_dir = index_html.parent.resolve()
    name = _candidate_name(None, app_dir, root)
    rel = str(app_dir.relative_to(root)) if _is_relative_to(app_dir, root) else str(app_dir)
    score = 35 + _path_score(root, app_dir) + _query_score(query_terms, [name, rel]) - _path_depth(root, app_dir)
    return WebAppCandidate(
        name=name,
        path=str(app_dir),
        kind="static",
        # sys.executable, not "python3": the flow CLI is itself Python, so this always
        # names a real interpreter. `python3` is a dangling Store alias on stock Windows.
        start_cmd=f'"{sys.executable}" -m http.server {{port}}',
        port=None,
        health="/",
        score=score,
        evidence=["index.html"],
    )


def _dependency_names(pkg: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        value = pkg.get(key)
        if isinstance(value, dict):
            names.update(str(name).lower() for name in value)
    return names


def _detect_framework(deps: set[str], scripts: dict[str, Any]) -> str | None:
    script_text = " ".join(str(v).lower() for v in scripts.values())
    if "next" in deps or "next dev" in script_text:
        return "next"
    if "vite" in deps or "vite" in script_text:
        return "vite"
    if "react-scripts" in deps or "react-scripts start" in script_text:
        return "react-scripts"
    if "astro" in deps or "astro dev" in script_text:
        return "astro"
    if "nuxt" in deps or "nuxt dev" in script_text:
        return "nuxt"
    if "@sveltejs/kit" in deps or "svelte-kit" in script_text:
        return "sveltekit"
    if "@angular/cli" in deps or "ng serve" in script_text:
        return "angular"
    return None


def _pick_start_script(scripts: dict[str, Any], framework: str | None) -> str | None:
    if "dev" in scripts:
        return "dev"
    if framework == "react-scripts" and "start" in scripts:
        return "start"
    if "start" in scripts and _script_looks_like_web_server(str(scripts["start"])):
        return "start"
    for name, value in scripts.items():
        if name in {"serve", "preview"} and _script_looks_like_web_server(str(value)):
            return str(name)
    return None


def _script_looks_like_web_server(script: str) -> bool:
    lowered = script.lower()
    return any(token in lowered for token in ("next", "vite", "astro", "nuxt", "ng serve", "react-scripts", "serve "))


def _package_manager_command(app_dir: Path, script_name: str) -> str:
    if (app_dir / "pnpm-lock.yaml").exists():
        return f"pnpm run {script_name}"
    if (app_dir / "yarn.lock").exists():
        return "yarn start" if script_name == "start" else f"yarn {script_name}"
    if (app_dir / "bun.lockb").exists() or (app_dir / "bun.lock").exists():
        return f"bun run {script_name}"
    return "npm start" if script_name == "start" else f"npm run {script_name}"


def _parse_port(script: str) -> int | None:
    patterns = (
        r"(?:--port|-p)\s+(\d{2,5})\b",
        r"--port=(\d{2,5})\b",
        r"\bPORT=(\d{2,5})\b",
        r"\b--server\.port\s+(\d{2,5})\b",
    )
    for pattern in patterns:
        match = re.search(pattern, script)
        if match:
            port = int(match.group(1))
            if 0 < port <= 65535:
                return port
    return None


def _candidate_name(package_name: Any, app_dir: Path, root: Path) -> str:
    if isinstance(package_name, str) and package_name.strip() and package_name.strip() not in {"app", "frontend"}:
        return package_name.strip()
    if _is_relative_to(app_dir, root):
        parts = [p for p in app_dir.relative_to(root).parts if p not in {".", ""}]
        if parts:
            return " / ".join(parts[-2:]) if len(parts) > 1 else parts[0]
    return app_dir.name or "Web App"


def _query_terms(query: str) -> set[str]:
    words = set(re.findall(r"[a-z0-9][a-z0-9_-]*", query.lower()))
    return {word for word in words if word not in GENERIC_QUERY_TERMS}


def _query_score(query_terms: set[str], fields: Iterable[str]) -> int:
    if not query_terms:
        return 0
    haystack = " ".join(fields).lower()
    matched = sum(1 for term in query_terms if term in haystack)
    if matched == 0:
        return -40
    return matched * 35


def _path_score(root: Path, path: Path) -> int:
    rel_parts = path.relative_to(root).parts if _is_relative_to(path, root) else path.parts
    lowered = {part.lower() for part in rel_parts}
    score = 0
    if lowered & {"app", "apps", "frontend", "ui", "web", "site", "client"}:
        score += 18
    if lowered & {"demo", "example", "examples", "scratch", "tmp", "temp"}:
        score -= 12
    return score


def _path_depth(root: Path, path: Path) -> int:
    if not _is_relative_to(path, root):
        return len(path.parts)
    return len(path.relative_to(root).parts)


def _inside_any(path: Path, roots: Iterable[Path]) -> bool:
    return any(_is_relative_to(path, root) for root in roots)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False

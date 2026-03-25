"""TemplateEngine — load .md templates, resolve dependencies, render with pybars."""

import html
from pathlib import Path
from typing import Dict, List

from pybars import Compiler

from .dependency import topological_sort
from .errors import DuplicateTemplateError, TemplateError
from .parser import extract_template_refs


class TemplateEngine:
    """Load Handlebars ``.md`` templates and render them with dependency resolution."""

    def __init__(self) -> None:
        self._templates: Dict[str, str] = {}
        self._compiler = Compiler()

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    def load_folder(self, folder: str | Path) -> None:
        """Recursively load all ``*.md`` files under *folder*.

        The template name is the file stem (e.g. ``skills/plain.md`` → ``plain``).
        Raises ``DuplicateTemplateError`` if two files share the same stem.
        """
        folder = Path(folder)
        if not folder.is_dir():
            raise TemplateError(f"Template folder does not exist: {folder}")

        for md_file in sorted(folder.rglob("*.md")):
            name = md_file.stem
            if name in self._templates:
                raise DuplicateTemplateError(
                    f"Duplicate template name '{name}': "
                    f"already loaded, now found in {md_file}"
                )
            self._templates[name] = md_file.read_text(encoding="utf-8")

    def load_template(self, name: str, content: str) -> None:
        """Programmatically register a template."""
        if name in self._templates:
            raise DuplicateTemplateError(f"Duplicate template name '{name}'")
        self._templates[name] = content

    # ------------------------------------------------------------------
    # Generation
    # ------------------------------------------------------------------

    def generate(self, root: str, context: dict | None = None) -> str:
        """Render *root* template with all reachable dependencies resolved.

        1. BFS from *root* to discover reachable templates.
        2. Build dep-map via ``extract_template_refs``.
        3. ``topological_sort`` → generation order.
        4. Render each template in order, storing result in working context.
        5. Return rendered *root*.
        """
        if root not in self._templates:
            raise TemplateError(f"Unknown template '{root}'")

        context = dict(context) if context else {}

        # 1. BFS to find reachable templates
        reachable = self._collect_reachable(root)

        # 2. Build dep map (only for reachable templates)
        dep_map: Dict[str, List[str]] = {}
        for name in reachable:
            dep_map[name] = extract_template_refs(self._templates[name])

        # 3. Topological sort
        order = topological_sort(dep_map)

        # 4. Render in order
        working: dict = dict(context)
        for name in order:
            if name in self._templates:
                rendered = self._render(self._templates[name], working)
                working[name] = rendered

        # 5. Return root result
        return working[root]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _collect_reachable(self, root: str) -> set[str]:
        """BFS from *root* through refs that are template names."""
        visited: set[str] = set()
        queue = [root]
        while queue:
            name = queue.pop(0)
            if name in visited:
                continue
            visited.add(name)
            refs = extract_template_refs(self._templates[name])
            for ref in refs:
                if ref in self._templates and ref not in visited:
                    queue.append(ref)
        return visited

    def _render(self, source: str, ctx: dict) -> str:
        """Compile and render a single Handlebars template."""
        template = self._compiler.compile(source)
        result = template(ctx)
        return html.unescape(result).rstrip(" \t")

    @property
    def template_names(self) -> List[str]:
        """Return sorted list of loaded template names."""
        return sorted(self._templates.keys())

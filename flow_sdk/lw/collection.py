"""A project's lw: every statement doc under its docs, checked and walked as one dependency tree.

Tags are the one tag system's. A block's tag is also listed in its doc's frontmatter ``tags`` (``put``
keeps it there), which is what binds the doc to the tag in the tag index — so ``flow tag get`` and the
tag graph find statement docs with no index of their own. A dependency names a block's tag or a doc's
tag; another project's tag carries its ``--<ns>--`` prefix and is looked up in that project's lw.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from flow_sdk.assets.frontmatter import _extract_frontmatter, _yaml_load, merge_frontmatter
from flow_sdk.assets.project_manifest import namespace_for, project_root_of
from flow_sdk.capsules.atomic import atomic_write, capsule_lock
from flow_sdk.fs_store.indexer.walk import gitignore_walk
from flow_sdk.fs_store.operations.namespace_roots import root_for
from flow_sdk.lw.blocks import Block, parse_blocks, render_block, validate
from flow_sdk.schema.data_spec.lw_spec import BLOCK_KINDS
from flow_sdk.tags.grammar import split_namespace


@dataclass
class Problem:
    path: Path
    line: int
    message: str

    def __str__(self) -> str:
        return f"{short(self.path)}:{self.line}: {self.message}"


@dataclass
class Collection:
    root: Path
    blocks: list[Block] = field(default_factory=list)
    doc_tags: dict[str, Path] = field(default_factory=dict)  # a frontmatter tag -> its doc
    doc_deps: dict[Path, list[str]] = field(default_factory=dict)  # a doc holding blocks -> its ``depends_on``
    #: Other projects' docs roots by namespace, for ``--<ns>--`` dependencies the machine cannot place itself.
    packages: dict[str, Path] = field(default_factory=dict)
    _by_tag: Optional[dict[str, Block]] = field(default=None, repr=False)

    def by_tag(self) -> dict[str, Block]:
        """The valid blocks by tag. Built once: a collection is read after it is loaded."""
        if self._by_tag is None:
            self._by_tag = {b.tag: b for b in self.blocks if b.tag}
        return self._by_tag

    def has(self, tag: str) -> bool:
        return tag in self.doc_tags or tag in self.by_tag()


def short(path: Path) -> str:
    """The path as typed from the working directory, when it is under it."""
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


def docs_root(start: Path) -> Path:
    """Where a project's statement docs are looked for: its ``docs`` folder, else the project itself."""
    project = project_root_of(start) or Path(start).resolve()
    return project / "docs" if (project / "docs").is_dir() else project


def _tag_list(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    return [v for v in value if isinstance(v, str) and v] if isinstance(value, list) else []


def _front(text: str) -> dict[str, Any]:
    raw = _extract_frontmatter(text)
    return _yaml_load(raw) if raw else {}


def _docs(root: Path) -> list[Path]:
    """The markdown files under ``root`` — what the indexer would see: ignored folders
    (``node_modules``, dot folders, anything ``.gitignore`` names) and symlinks are left out."""
    return [path.resolve() for _dir, _subdirs, files in gitignore_walk(root) for path in files if path.suffix.casefold() == ".md"]


def load(root: Path, overrides: Optional[dict[Path, str]] = None, packages: Optional[dict[str, Path]] = None) -> Collection:
    """Read every doc under ``root``. ``overrides`` stands in for file contents not written yet."""
    overrides = {p.resolve(): t for p, t in (overrides or {}).items()}
    collection = Collection(Path(root).resolve(), packages=dict(packages or {}))
    for path in sorted(set(_docs(collection.root)) | set(overrides)):
        # A doc that is not valid UTF-8 is still a doc: its readable part is read, never a crash.
        text = overrides[path] if path in overrides else path.read_text(encoding="utf-8", errors="replace")
        front = _front(text)
        # ``tag`` is the doc's own tag; ``tags`` is every tag the index binds the doc to.
        for tag in _tag_list(front.get("tag")) + _tag_list(front.get("tags")):
            collection.doc_tags.setdefault(tag, path)
        found = parse_blocks(text, path) if any(kind in text for kind in BLOCK_KINDS) else []
        if found:
            collection.blocks += found
            collection.doc_deps[path] = _tag_list(front.get("depends_on"))
    return collection


class _Resolver:
    """Answers "does this dependency name something", once per tag, for one check."""

    def __init__(self, collection: Collection) -> None:
        self.collection = collection
        self.own = set(collection.doc_tags) | set(collection.by_tag())
        self.namespace = namespace_for(collection.root)
        self.foreign: dict[str, Optional[set[str]]] = {}

    def why_not(self, dep: str) -> Optional[str]:
        """Why ``dep`` names nothing, or None when it resolves."""
        ns, bare = split_namespace(dep)
        if ns is None or ns == self.namespace:
            return None if bare in self.own else "no block or doc has this tag"
        if ns not in self.foreign:
            project = self.collection.packages.get(ns) or root_for(ns)
            other = load(docs_root(project)) if project else None
            self.foreign[ns] = (set(other.doc_tags) | set(other.by_tag())) if other else None
        names = self.foreign[ns]
        if names is None:
            return f"the package '{ns}' is not known here"
        return None if bare in names else f"the package '{ns}' has no block or doc with this tag"


def check(collection: Collection) -> list[Problem]:
    """Every problem in the collection: each block on its own, then the links between them."""
    out = [Problem(b.path, b.line, p) for b in collection.blocks for p in b.problems]
    by_tag: dict[str, Block] = {}
    for block in collection.blocks:
        if not block.tag:
            continue
        if block.tag in by_tag:
            first = by_tag[block.tag]
            out.append(Problem(block.path, block.line, f"tag '{block.tag}' is already used at {short(first.path)}:{first.line}"))
        else:
            by_tag[block.tag] = block
    resolver = _Resolver(collection)
    for block in collection.blocks:
        for dep in block.depends_on:
            if why := resolver.why_not(dep):
                out.append(Problem(block.path, block.line, f"depends_on '{dep}': {why}"))
    for path, deps in collection.doc_deps.items():
        for dep in deps:
            if why := resolver.why_not(dep):
                out.append(Problem(path, 1, f"depends_on '{dep}': {why}"))
    edges = {tag: [d for d in block.depends_on if d in by_tag] for tag, block in by_tag.items()}
    for cycle in _cycles(edges):
        block = by_tag[cycle[0]]
        out.append(Problem(block.path, block.line, "dependency cycle: " + " -> ".join(cycle + [cycle[0]])))
    return out


def _cycles(edges: dict[str, list[str]]) -> list[list[str]]:
    """One entry per cycle, each starting at its smallest tag so a cycle is reported once.
    Iterative: a dependency chain may be deeper than the interpreter's call stack."""
    found, state = [], {}
    for start in sorted(edges):
        if start in state:
            continue
        state[start] = 1
        trail, stack = [start], [iter(edges.get(start, []))]
        while stack:
            nxt = next(stack[-1], None)
            if nxt is None:
                state[trail.pop()] = 2
                stack.pop()
            elif state.get(nxt) == 1:
                cycle = trail[trail.index(nxt):]
                pivot = cycle.index(min(cycle))
                found.append(cycle[pivot:] + cycle[:pivot])
            elif nxt not in state:
                state[nxt] = 1
                trail.append(nxt)
                stack.append(iter(edges.get(nxt, [])))
    return found


def related(collection: Collection, tag: str, dependents: bool = False) -> list[Block]:
    """The block for ``tag``, then every block it depends on, nearest first; with ``dependents``,
    every block that depends on it instead."""
    by_tag = collection.by_tag()
    if tag not in by_tag:
        return []
    seen, queue = [tag], [tag]
    while queue:
        node = queue.pop(0)
        nxt = [t for t, b in by_tag.items() if node in b.depends_on] if dependents else by_tag[node].depends_on
        for other in nxt:
            if other in by_tag and other not in seen:
                seen.append(other)
                queue.append(other)
    return [by_tag[t] for t in seen]


def tree(collection: Collection, tag: str) -> list[tuple[int, str, Optional[Block], bool]]:
    """The dependency tree under ``tag`` as ``(depth, tag, block, repeated)`` rows, the way a package
    manager lists it: a shared dependency appears under each thing that uses it, but its own
    dependencies are listed only the first time (``repeated`` marks the later ones). A doc's own tag
    lists the doc's blocks; another package's tag is a leaf."""
    by_tag = collection.by_tag()
    if not collection.has(tag):
        return []

    def children(name: str) -> list[str]:
        block = by_tag.get(name)
        if block is None and name in collection.doc_tags:
            # A doc's own tag: the blocks the doc holds, then what the doc itself depends on.
            doc = collection.doc_tags[name]
            return [b.tag for b in collection.blocks if b.path == doc and b.tag] + collection.doc_deps.get(doc, [])
        return block.depends_on if block else []

    rows: list[tuple[int, str, Optional[Block], bool]] = []
    expanded: set[str] = set()
    stack = [(0, tag)]
    while stack:
        depth, name = stack.pop()
        repeated = name in expanded
        rows.append((depth, name, by_tag.get(name), repeated and bool(children(name))))
        if not repeated:
            expanded.add(name)
            stack.extend((depth + 1, child) for child in reversed(children(name)))
    return rows


def _read(doc: Path) -> tuple[str, str]:
    """The doc's text with ``\\n`` line ends, and the line end the file really uses."""
    raw = doc.read_bytes().decode("utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    return raw.replace("\r\n", "\n"), newline


def _write(doc: Path, text: str, newline: str) -> None:
    atomic_write(doc, text.replace("\n", newline).encode("utf-8"))


def put(doc: Path, kind: str, tag: str, body: dict, root: Optional[Path] = None) -> list[Problem]:
    """Write one block into ``doc``: replace the block carrying ``tag``, or add it at the end, and
    list the tag in the doc's frontmatter ``tags``. The rest of the file is left as it is, line ends
    included. Nothing is written when the result has a problem in this doc; the problems are returned
    instead. Two writers of one doc take turns."""
    doc = Path(doc).resolve()
    if not doc.is_file():
        return [Problem(doc, 1, "the doc does not exist; create it first")]
    spec, problems = validate(kind, {**body, "tag": tag})
    if spec is None:
        return [Problem(doc, 1, p) for p in problems]
    with capsule_lock(doc):
        try:
            text, newline = _read(doc)
        except UnicodeDecodeError:
            return [Problem(doc, 1, "the doc is not valid UTF-8")]
        current = next((b for b in parse_blocks(text, doc) if b.tag == tag), None)
        if current and current.kind != kind:
            return [Problem(doc, current.line, f"tag '{tag}' is a {current.kind} block here, not {kind}")]
        if current:
            lines = text.split("\n")
            rendered = [current.indent + line for line in render_block(spec).split("\n")]
            new_text = "\n".join(lines[:current.line - 1] + rendered + lines[current.end_line:])
        else:
            new_text = text.rstrip("\n") + "\n\n" + render_block(spec) + "\n"
        tags = _tag_list(_front(new_text).get("tags"))
        if tag not in tags:
            new_text = merge_frontmatter(new_text, {"tags": tags + [tag]})
        found = [p for p in check(load(root or docs_root(doc), {doc: new_text})) if p.path == doc]
        if not found:
            _write(doc, new_text, newline)
        return found


def remove(doc: Path, tag: str, root: Optional[Path] = None) -> list[Problem]:
    """Delete the block carrying ``tag`` from ``doc``. Refused while another block depends on it."""
    doc = Path(doc).resolve()
    if not doc.is_file():
        return [Problem(doc, 1, f"no block has the tag '{tag}' in this doc")]
    with capsule_lock(doc):
        try:
            text, newline = _read(doc)
        except UnicodeDecodeError:
            return [Problem(doc, 1, "the doc is not valid UTF-8")]
        current = next((b for b in parse_blocks(text, doc) if b.tag == tag), None)
        if current is None:
            return [Problem(doc, 1, f"no block has the tag '{tag}' in this doc")]
        users = [b.tag for b in load(root or docs_root(doc)).blocks if tag in b.depends_on]
        if users:
            return [Problem(doc, current.line, f"still depended on by: {', '.join(users)}")]
        lines = text.split("\n")
        before, after = lines[:current.line - 1], lines[current.end_line:]
        while before and after and not before[-1].strip() and not after[0].strip():
            after = after[1:]
        _write(doc, "\n".join(before + after), newline)
        return []

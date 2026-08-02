"""SubprocessScanIndexer — real child process, real walk, no mocks.

The child is pure filesystem discovery with zero DB access, so it runs honestly
in a temp tree; nothing here needs to be faked. The headline test is scan parity:
the child must return byte-identical candidates to the in-process walk, which is
what proves flattening ``FSRef.parent`` into resolved ``scope`` / ``project_id`` /
``read_only`` across the process boundary loses nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.auto_index import ScanMode
from flow_sdk.fs_store.indexer.builtin import build_default_indexer
from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.subprocess_scan import SubprocessScanIndexer
from flow_sdk.fs_store.record_types import RecordType

pytestmark = pytest.mark.timeout(10)


def _ref_key(r: FSRef) -> tuple:
    """Everything the index phase reads off a scanned ref.

    ``parent`` is part of the key, not an afterthought: ``index()`` derives each
    record's enclosure ``parent_type_id`` from ``ref._parent``
    (``index_function.ref_typeid(getattr(ref, "_parent", None))``). A key without
    it lets a wire format that drops the chain pass parity while silently
    unparenting every received asset — which is exactly what happened before
    ``candidates_with_parents`` existed.
    """
    parent = getattr(r, "_parent", None)
    return (
        r.path,
        str(r.record_type) if r.record_type is not None else None,
        r.scope,
        r.project_id,
        r.json_path,
        r.read_only,
        # Identity of the parent, as the enclosure derivation would resolve it.
        None if parent is None else (parent.path, str(parent.record_type)),
    )


@pytest.fixture()
def project_tree(tmp_path: Path) -> Path:
    """A project with a skill, an agent, a loose markdown, and a two-server
    .mcp.json — the last one matters because its refs carry a ``json_path``
    fragment pointer, the field most likely to be dropped by a naive wire format.

    Deliberately a SUBDIRECTORY of ``tmp_path``: conftest points the test
    instance's records root at ``tmp_path/records``, and the child process
    materializes that directory when it resolves its instance. Rooting the scan at
    ``tmp_path`` itself would put the shadow store inside the walked tree, so the
    child would legitimately report a ``records`` folder the in-process scan (which
    ran before the dir existed) did not — a fixture artifact, not a wire bug. Real
    projects never contain the instance records root.
    """
    tmp_path = tmp_path / "proj"
    skill_dir = tmp_path / ".claude" / "skills" / "demo"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\ndescription: a demo skill\n---\nbody\n", encoding="utf-8"
    )
    agents = tmp_path / ".claude" / "agents"
    agents.mkdir(parents=True)
    (agents / "helper.md").write_text("---\nname: helper\n---\nagent body\n", encoding="utf-8")
    (tmp_path / "notes.md").write_text("# notes\n", encoding="utf-8")
    (tmp_path / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"one": {"command": "x"}, "two": {"command": "y"}}}),
        encoding="utf-8",
    )
    return tmp_path


def _roots(tree: Path, project_id: str = "pid-sub-1") -> tuple[FSRef, ...]:
    return (
        FSRef(
            tree,
            record_type=RecordType.REAL_PROJECT_CWD,
            scope="project",
            project_id=project_id,
        ),
    )


async def _scan(tree: Path, mode: ScanMode, project_id: str = "pid-sub-1") -> list[FSRef]:
    """Scan ``tree`` in the given mode — the one line every test below shares."""
    return await build_default_indexer(scan_mode=mode).scan(_opts(tree, project_id))


def _opts(tree: Path, project_id: str = "pid-sub-1") -> IndexerOptions:
    # include_temp: tmp_path lives under /var/folders on macOS, which the default
    # walk skips as a temp root. The behaviour under test is orthogonal to that.
    return IndexerOptions(roots=_roots(tree, project_id), verbose=False, include_temp=True)


@pytest.mark.asyncio
async def test_subprocess_scan_matches_in_process_scan(project_tree: Path) -> None:
    """The headline: identical candidate sets from both scan modes."""
    in_process = await _scan(project_tree, ScanMode.THREAD)
    via_child = await _scan(project_tree, ScanMode.SUBPROCESS)

    assert sorted(map(_ref_key, via_child)) == sorted(map(_ref_key, in_process))
    # Guard against a vacuous pass if the fixture ever stops producing records.
    assert in_process, "fixture produced no candidates"
    types = {str(r.record_type) for r in via_child}
    assert {"skill", "subagent", "markdown", "mcp_server"} <= types


@pytest.mark.asyncio
async def test_fragment_refs_keep_their_json_path(project_tree: Path) -> None:
    """``json_path`` survives the boundary — one ref per MCP server, not per file."""
    refs = await _scan(project_tree, ScanMode.SUBPROCESS)
    pointers = sorted(
        r.json_path for r in refs if str(r.record_type) == "mcp_server" and r.json_path
    )
    assert pointers == ["/mcpServers/one", "/mcpServers/two"]


@pytest.mark.asyncio
async def test_parent_chain_survives_the_boundary(project_tree: Path) -> None:
    """``ref._parent`` must cross, because ``index()`` derives parenting from it.

    ``ref_typeid(ref._parent)`` is what produces a received asset's
    ``parent_type_id``; the resolved scope/project_id fields cannot substitute.
    Assert the child returns the same parent *shape* as the in-process walk, and
    that it is not simply parentless everywhere.
    """
    in_process = await _scan(project_tree, ScanMode.THREAD)
    via_child = await _scan(project_tree, ScanMode.SUBPROCESS)

    def parents(refs):
        # "" for no parent: a None second element makes the tuples unorderable.
        return sorted(
            (r.path, "" if getattr(r, "_parent", None) is None else r._parent.path)
            for r in refs
        )

    assert parents(via_child) == parents(in_process)
    # The tree is nested, so a correct scan must produce real parents — otherwise
    # this test would pass against a format that drops the chain entirely.
    assert any(getattr(r, "_parent", None) is not None for r in via_child)


@pytest.mark.asyncio
async def test_project_id_is_inherited_through_the_boundary(project_tree: Path) -> None:
    """Leaf refs carry the ROOT's project_id.

    In-process that works because ``FSRef.project_id`` walks ``.parent``; the
    child has no parent chain to walk, so this is what proves the resolved value
    is what gets serialized.
    """
    refs = await _scan(project_tree, ScanMode.SUBPROCESS, "pid-inherit-9")
    assert refs
    assert {r.project_id for r in refs} == {"pid-inherit-9"}
    assert {r.scope for r in refs} == {"project"}


@pytest.mark.asyncio
async def test_unspawnable_child_falls_back_to_in_process(
    project_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-open: a child that cannot start must not lose candidates.

    Repointing the interpreter is environment setup, not a stand-in for the unit
    under test — the real spawn still runs and really fails.
    """
    expected = await _scan(project_tree, ScanMode.THREAD)
    monkeypatch.setattr(sys, "executable", "/nonexistent/python-does-not-exist")

    got = await _scan(project_tree, ScanMode.SUBPROCESS)

    assert sorted(map(_ref_key, got)) == sorted(map(_ref_key, expected))
    assert got


@pytest.mark.asyncio
async def test_truncated_stream_is_a_failure_not_an_empty_scan(
    project_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A child that dies mid-stream must fall back, never return a partial set.

    This is the most dangerous failure in the feature: a short candidate list
    reaching ``index()`` would let the orphan sweep delete every record the child
    never got to emit. The terminal ``result`` line is what makes the difference
    detectable, so a stream without one has to be rejected.
    """
    expected = await _scan(project_tree, ScanMode.THREAD)
    assert len(expected) > 2, "fixture must produce more than the stub emits"

    indexer = build_default_indexer(scan_mode=ScanMode.SUBPROCESS)
    assert isinstance(indexer, SubprocessScanIndexer)

    stub = Path(project_tree) / "truncating_child.py"
    stub.write_text(
        "import json, sys\n"
        "sys.stdin.read()\n"
        "print(json.dumps({'path': '/tmp/a.md', 'record_type': 'markdown',\n"
        "                  'scope': 'user', 'project_id': '', 'json_path': ''}))\n"
        "print(json.dumps({'path': '/tmp/b.md', 'record_type': 'markdown',\n"
        "                  'scope': 'user', 'project_id': '', 'json_path': ''}))\n"
        "sys.exit(0)\n",  # exits 0 with NO result line
        encoding="utf-8",
    )

    import asyncio  # noqa: PLC0415

    real_exec = sys.executable
    # Bind the REAL spawner before patching. Calling the patched name from inside
    # the replacement recurses until RecursionError — which the fail-open handler
    # would then catch, making this test pass for entirely the wrong reason.
    real_spawn = asyncio.create_subprocess_exec

    async def _spawn_stub(*_args, **kwargs):
        return await real_spawn(
            real_exec,
            str(stub),
            stdin=kwargs.get("stdin"),
            stdout=kwargs.get("stdout"),
            stderr=kwargs.get("stderr"),
            env=kwargs.get("env"),
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _spawn_stub)
    got = await indexer.scan(_opts(project_tree))
    monkeypatch.undo()

    # Fell back to the real walk rather than trusting the 2 truncated candidates.
    assert len(got) == len(expected)
    assert sorted(map(_ref_key, got)) == sorted(map(_ref_key, expected))


@pytest.mark.asyncio
async def test_child_resolves_this_instance_not_prod(
    project_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty FLOW_INSTANCE in the parent must not leak `prod` into the child.

    ``special_folders._home()`` and ``default_roots()`` both key off
    get_instance_settings(), so a child resolving the wrong instance would walk a
    different tree entirely. The parent re-stamps the value rather than
    setdefault-ing it, so the scan still succeeds with an empty parent env.
    """
    from flow_sdk.instance_settings import get_instance_settings

    expected_instance = get_instance_settings().instance_name
    assert expected_instance != "prod", "test must not run against the prod instance"

    monkeypatch.setenv("FLOW_INSTANCE", "")
    refs = await _scan(project_tree, ScanMode.SUBPROCESS)

    # A child resolved to the wrong instance would fail or return a foreign tree;
    # matching the in-process walk over our explicit roots proves it did not.
    in_process = await _scan(project_tree, ScanMode.THREAD)
    assert sorted(map(_ref_key, refs)) == sorted(map(_ref_key, in_process))
    assert refs


def test_scan_child_never_recurses_into_another_subprocess() -> None:
    """The fork-bomb guard.

    ``scan_child`` must pass ScanMode.THREAD explicitly. If it took the default it
    would re-read the preference, resolve SUBPROCESS, and every child would spawn
    its own child.
    """
    import inspect

    from flow_sdk.fs_store.indexer import scan_child

    # inspect, not a relative path read: this must hold no matter where pytest runs.
    assert "scan_mode=ScanMode.THREAD" in inspect.getsource(scan_child._run)

    # And the mode it names really does yield the in-process class.
    assert build_default_indexer(scan_mode=ScanMode.THREAD).__class__ is FSIndexer

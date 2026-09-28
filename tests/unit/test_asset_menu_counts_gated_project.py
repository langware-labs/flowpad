"""A type row's count must be backed by rows its list can actually show.

Symptom (prod, flowpad-oss): the Assets sidebar showed "Prompts 1", but expanding
the row said "Empty" and the list page said "No results found".

The two halves of that row come from different places:

* the COUNT is ``max(asset-stats, get-assets?menu=true)`` (useAssetsModel
  ``typeCounts``) — and the menu scanned the DISK;
* the LIST is ``/search`` — the INDEX.

A project mounted under ``~/Documents`` (a protected folder) is never walked by
the background auto-index while the folder's consent is ``ask`` (the default):
``_resolve_scoped_roots(foreground=False)`` → ``gate_root`` → ASK → no root. The
menu read the same folder ungated, so it counted a prompt the index never held.

Proven switch: ``preferences.indexing.folders.documents`` — ``ask`` → menu 1 /
index 0; ``allow`` → the auto-index walks the mount and both say 1. The fix
gates the menu with the same decision, so both consent states agree.

No mocks: sandboxed $HOME, a real Project row, the real auto-index on the real
ComputeNode host, the real menu action and the real asset-stats count.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (walkers + TypeInfos)
from flow_sdk.builtin.asset_menu import BrowsingOptions
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.indexer import index_log
from flow_sdk.fs_store.indexer.special_folders import PREF_PREFIX, STATE_ALLOW, STATE_ASK
from flow_sdk.fs_store.operations.all_projects import invalidate_projects_cache
from flow_sdk.preferences import write_instance_pref
from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase without approval

PROMPT_MD = "---\nname: report issue\n---\n\nClicking Report Issue does nothing.\n"


@pytest.mark.parametrize(("consent", "expected"), [(STATE_ASK, 0), (STATE_ALLOW, 1)])
async def test_menu_count_of_a_documents_project_is_backed_by_the_index(
    consent: str, expected: int, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path))
    monkeypatch.setenv("FLOWPAD_INDEX_SCAN_MODE", "thread")
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    write_instance_pref(PREF_PREFIX + "documents", consent)

    # This repo's own shape: ~/Documents/dev/flowpad-oss with one prompt.
    mount = tmp_path / "Documents" / "dev" / "flowpad-oss"
    (mount / "agentic-assets" / "prompt").mkdir(parents=True)
    (mount / "agentic-assets" / "prompt" / "report_issue.md").write_text(PROMPT_MD)

    project = Project(name="flowpad-oss", fs_storage_mount_path=str(mount))
    await project.save()
    invalidate_projects_cache()
    pid = str(project.id)

    # What selecting the project does: the background auto-index, on the real
    # host (a bare mixin lacks the activity machinery and fails silently).
    await ComputeNode(name="menu-fixture")._auto_index_project(pid, force=True, trigger="test")

    menu = (await project.get_assets_action(browsing=BrowsingOptions(menu=True))).data["menu"]
    menu_count = next((g["count"] for g in menu["root"]["groups"] if g["type_name"] == "prompt"), 0)
    scope = await resolve_project_scope(ScopeFilter(user=False, projects=(pid,)))
    indexed_count = (await index_log.get_asset_stats(scope=scope)).per_type.get("prompt", 0)

    assert indexed_count == expected, f"consent={consent}: the auto-index should hold {expected} prompt(s)"
    assert menu_count == indexed_count, (
        f"sidebar would show 'Prompts {menu_count}' but the list (the index) holds {indexed_count}"
    )

    reset_instance_settings()

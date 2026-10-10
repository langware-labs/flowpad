"""Pins ``docs/snippets/asset-dependencies.md``: every python fence runs as written, in order, as
one session — three layered folder sources, the personal one brought in, the rest following it.

# do not increase timeout without approval
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.assets import flow_json
from flow_sdk.dependencies import resolve as dep_resolve
from flow_sdk.schema.type_info import register_all
from tests.utils.snippets import run_page

register_all()

pytestmark = [pytest.mark.timeout(15), pytest.mark.usefixtures("home")]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _no_hub(monkeypatch):
    async def nobody(_typeid):
        return None

    monkeypatch.setattr(dep_resolve, "hub_lookup", nobody)


#: What each Google Doc exports as — the fake Drive answers one fixed body for every export.
DOCS = {
    "f0": "# Company handbook\n\nEvery employee gets 24 vacation days a year.\n",
    "f1": "# Sales playbook\n\nUp to 15 percent discount without approval.\n",
    "f2": "# Dana notes\n\nMy top account this quarter is Globex.\n",
}


@pytest.fixture
def drive(monkeypatch):
    """§7's Drive: the gdrive asset's own loopback double, holding ``Knowledge/{Company,Sales,Dana}``
    with one Google Doc each, behind a doubled ``google`` connection."""
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
    from flow_sdk.sources.testing.http import local_http_server
    from tests.utils.snippets import point_driver_at

    fake = load_module(SHIPPED_ROOT / "gdrive" / "tests", "test_gdrive_source")
    doc = "application/vnd.google-apps.document"
    tree = [fake._folder("kb", "Knowledge")]
    for i, (folder, title) in enumerate((("Company", "Company handbook"), ("Sales", "Sales playbook"), ("Dana", "Dana notes"))):
        tree += [fake._folder(f"d{i}", folder, "kb"), fake._in(fake._file(f"f{i}", title, doc), f"d{i}")]
    served = fake._Drive(tree)

    def serve(path, headers):
        for file_id, text in DOCS.items():
            if f"/files/{file_id}/export" in path:
                return 200, text.encode(), {}
        return served(path, headers)

    with local_http_server(serve) as base:
        point_driver_at(monkeypatch, "gdrive", "DRIVE_API_BASE", base)
        monkeypatch.setattr(DataDriver.loaded("gdrive"), "credentials_for", fake._credentials(fake.TOKEN))
        yield


def _answer_from_the_handbook(turn) -> str:
    """Find the company handbook in the process's context folders — never in its prompt — and
    answer with the number in it, reading it the way a worker would."""
    for folder in turn.process.resolved_add_dirs:
        handbook = Path(folder) / "Company handbook.md"
        if handbook.is_file():
            return turn.read(handbook).split("gets ", 1)[1].split(" ", 1)[0]
    return "I could not find the company handbook in my context."


@pytest.mark.long  # 2.96s — six sources, three verified and synced against the loopback Drive, one worker turn
async def test_every_fence_runs_as_written(initialize_test_db, drive, mock_driver):
    worker = mock_driver(_answer_from_the_handbook)
    ns = await run_page("asset-dependencies.md")

    assert [(s.name, s.state) for s in await ns["site"].dependencies() if s.state == "ready"] == [
        ("me", "ready"), ("team-kb", "ready"),
    ], "§5 removed the company layer"
    assert ns["missing"].state == "not_found"

    drive_states = await ns["reader"].dependencies()
    assert [(s.name, s.state, s.via_path) for s in drive_states] == [
        ("me", "ready", []), ("team-kb", "ready", ["me"]), ("company-kb", "ready", ["me", "team-kb"]),
    ]
    assert [sorted(p.name for p in Path(s.local_path).glob("*.md")) for s in drive_states] == [
        ["Dana notes.md"], ["Sales playbook.md"], ["Company handbook.md"],
    ], "each layer's Google Doc is in the reader's context, exported as markdown"
    assert all(src.status == "active" for src in (ns["company_docs"], ns["sales_docs"], ns["dana_docs"]))
    assert {s.local_path for s in drive_states} <= set(ns["reader"].include_dirs)

    assert (ns["result"].ok, ns["result"].text) == (True, "24"), "§8: the answer came from the root layer"
    assert len(worker.received_prompts) == 1 and str(ns["company_docs"].files_root) not in worker.received_prompts[0], (
        "the prompt names the file but not where it is — the dependency chain put it in context"
    )
    assert ns["proc"].cli_config.get("model") == "sm", "the small model, by its portable size"
    declared = flow_json.read(Path(ns["ask"].fs_storage_mount_path)).entries()
    assert [e.name for e in declared] == ["me"], "the project names only the personal layer"

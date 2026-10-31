"""A shared credential spec lands where a pull would put it.

Eran shares the Bright Data credential (names only, never a value); Ami
brings it into his own checkout of the project. Either way in — opening the
share or pulling on his own — ends in the same place: the credential folder
in Ami's project, one row, and the project's setup lists it as missing.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.builtin.project_setup import readiness_of
from flow_sdk.responses.response import ApiSuccessResponse
from tests.unit.git_share._world import BRANCH, git, shared_dirs

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _setup_names(project_id: str) -> set[str]:
    project = await Project.get_one({"id": project_id})
    assert project is not None
    ready = await readiness_of(project)
    return {r.name for r in ready.to_do}


async def test_a_shared_credential_comes_into_my_project_and_setup_asks_for_it(make_world):
    w = make_world("credential")
    mine = w.receiver_clone(branch="main")  # Ami is on main; the credential was committed on a branch

    res, row = await w.share(project_root=mine, apply=True)

    assert isinstance(res, ApiSuccessResponse) and not (res.data or {}).get("needs"), getattr(res, "message", res)
    assert row is not None
    assert Path(row.asset_ref).resolve() == (mine / w.family.rel_path).resolve(), "not in Ami's project"
    assert not shared_dirs(w.root)
    assert row.project_id, "the credential belongs to no project"
    assert "bright_data" in await _setup_names(row.project_id), "the project's setup does not ask for the shared credential"


async def test_pulling_on_my_own_reaches_the_same_place_as_opening_the_share(make_world):
    w = make_world("credential")
    mine = w.receiver_clone(branch=BRANCH)
    git(mine, "reset", "-q", "--hard", "origin/main")  # Ami is behind: the credential is not here yet

    _res, row = await w.share(project_root=mine, apply=True)  # a pull, Ami said yes

    pulled_alone = w.receiver_clone(name="pulled", branch=BRANCH)
    assert row is not None
    assert git(mine, "rev-parse", "HEAD") == git(pulled_alone, "rev-parse", "HEAD"), "not the same git state"

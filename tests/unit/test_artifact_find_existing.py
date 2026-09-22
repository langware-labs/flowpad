"""`Artifact.find_existing` — the idempotency seam registration converges on.

Re-registering a deliverable must land on the row that already represents it
instead of minting a second one, and it must do so by LOOKUP on the natural
key — never by deriving an id, which would bake a key into a name that can
then never change (see the entity id policy).

The scope is the caller's, and the two scopes differ on purpose:

* RUN (``generated_by``) for a file or a row — provenance is per-run, and an
  artifact may itself be an event ("a message it sent"), so two runs producing
  the same path are two artifacts.
* PROJECT (``project_id``) for a web app — an app is a durable asset of the
  project, not of the run that happened to build it.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.artifact import Artifact

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

_RUN_A = "agentic_process-3f2a1b4c-0000-4000-8000-00000000000a"
_RUN_B = "agentic_process-3f2a1b4c-0000-4000-8000-00000000000b"
_PROJ = "11111111-0000-4000-8000-000000000001"


async def _mint(**fields) -> Artifact:
    artifact = Artifact(name=fields.pop("name", "thing"), kind=fields.pop("kind", "content.file.text"), **fields)
    await artifact.save(notify=False)
    return artifact


# ── addressing ────────────────────────────────────────────────────────────────


async def test_finds_by_asset_ref_within_the_run():
    made = await _mint(asset_ref="/tmp/report.md", generated_by=_RUN_A)

    found = await Artifact.find_existing(generated_by=_RUN_A, asset_ref="/tmp/report.md")

    assert found is not None and found.id == made.id


async def test_finds_by_target_type_id_for_a_file_less_deliverable():
    """A message an agent sent has no path — the row IS the deliverable."""
    made = await _mint(target_type_id="source_item-abc", generated_by=_RUN_A)

    found = await Artifact.find_existing(generated_by=_RUN_A, target_type_id="source_item-abc")

    assert found is not None and found.id == made.id


async def test_unknown_address_is_a_miss_not_an_arbitrary_row():
    await _mint(asset_ref="/tmp/report.md", generated_by=_RUN_A)

    assert await Artifact.find_existing(generated_by=_RUN_A, asset_ref="/tmp/other.md") is None


async def test_no_address_never_converges():
    """Absent an address this is a caller bug, not a wildcard — returning the
    first row of the scope would silently graft one deliverable onto another."""
    await _mint(asset_ref="/tmp/report.md", generated_by=_RUN_A)

    assert await Artifact.find_existing(generated_by=_RUN_A) is None


# ── scope ─────────────────────────────────────────────────────────────────────


async def test_run_scope_does_not_reach_another_runs_artifact():
    """Two runs producing the same path are two artifacts: provenance is
    per-run, so converging here would silently reassign authorship."""
    await _mint(asset_ref="/tmp/report.md", generated_by=_RUN_A)

    assert await Artifact.find_existing(generated_by=_RUN_B, asset_ref="/tmp/report.md") is None


async def test_project_scope_converges_across_runs():
    """An app is the project's, so whoever re-registers it finds the one row."""
    made = await _mint(kind="application.web", asset_ref="/srv/app", project_id=_PROJ, generated_by=_RUN_A)

    found = await Artifact.find_existing(project_id=_PROJ, asset_ref="/srv/app")

    assert found is not None and found.id == made.id


async def test_exactly_one_scope_is_required():
    with pytest.raises(ValueError):
        await Artifact.find_existing(asset_ref="/tmp/report.md")
    with pytest.raises(ValueError):
        await Artifact.find_existing(generated_by=_RUN_A, project_id=_PROJ, asset_ref="/tmp/report.md")


# ── origin ────────────────────────────────────────────────────────────────────


async def test_finds_by_local_origin_path(tmp_path):
    """The webapp path addresses by where the app lives, not by `asset_ref`."""
    app_dir = tmp_path / "frontend"
    app_dir.mkdir()
    made = await _mint(kind="application.web", path=str(app_dir), project_id=_PROJ)
    assert made.local_origin_path() is not None, "a local path must yield an origin to match on"

    found = await Artifact.find_existing(project_id=_PROJ, origin_path=made.local_origin_path())

    assert found is not None and found.id == made.id

"""Regression: a fresh project's scoped entity lists must be empty.

Bug (RCA this session): the scoped list route
``GET /api/v1/graph/project/<project_id>/<type>`` resolves its auth source to
the *user* (because ``target_entity_typeid`` is None for a type-list query) and
falls through ``handle_query_resource`` lines 34-38 to ``request_info.user``.
``_user_has_access`` then sees a user source, SKIPS the child-of-project scope
walk, and returns every entity the user owns — so a brand-new empty project's
Project-assets side menu shows the user's global ``~/.claude`` plans and
``~/prompts``.

This test seeds user-level (``project_id=None``) prompt + plan entities that are
NOT children of a freshly created project, then asks that project's scoped list
endpoints for its stats. They must be 0.
"""

from pathlib import Path

import pytest

from flow_sdk.builtin.prompt import Prompt
from flow_sdk.builtin.claude_memory_entities import ClaudePlan

pytestmark = pytest.mark.asyncio


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_fresh_project_scoped_stats_are_zero(bootstrapped_client, user, tmp_path):
    client = bootstrapped_client

    # User-level entities, exactly like the real indexed ~/.claude plans and
    # ~/prompts: project_id is None and asset_ref lives outside any project.
    home = tmp_path / "home"
    (home / ".claude" / "plans").mkdir(parents=True, exist_ok=True)
    (home / "prompts").mkdir(parents=True, exist_ok=True)

    plan_path = home / ".claude" / "plans" / "global-plan.md"
    plan_path.write_text("# A user-level plan, in no project\n")
    await ClaudePlan(
        name="global-plan",
        asset_ref=str(plan_path),
    ).save()

    prompt_path = home / "prompts" / "global-prompt.md"
    prompt_path.write_text("Do the thing.\n")
    await Prompt(
        name="global-prompt",
        text="Do the thing.",
        asset_ref=str(prompt_path),
    ).save()

    # A brand-new, empty project — its mount is its own folder, nothing in it.
    resp = await client.post(
        "/api/v1/graph/project",
        json={"type": "project", "name": "proj_zero",
              "fs_storage_mount_path": str(tmp_path / "proj_zero")},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    project_id = resp.json()["data"]["id"]

    # The Project-assets side menu fetches each type via these scoped routes.
    plan_resp = await client.get(f"/api/v1/graph/project/{project_id}/plan")
    prompt_resp = await client.get(f"/api/v1/graph/project/{project_id}/prompt")

    plans = plan_resp.json()["data"]
    prompts = prompt_resp.json()["data"]

    assert plans == [], f"expected 0 plans in fresh project, got {len(plans)}"
    assert prompts == [], f"expected 0 prompts in fresh project, got {len(prompts)}"

    # The "Project assets" by-type tree badges read from the per-type COUNT
    # endpoint (asset-stats), a different scope path than the list above. A
    # fresh project must count 0 of each — the user-level (scope-less) plans
    # and prompts must not leak into a project's counts.
    stats_resp = await client.get(
        "/api/v1/graph/compute_node/@local/fs-records/asset-stats"
        f"?user=false&projects={project_id}"
    )
    per_type = stats_resp.json()["data"]["per_type"]
    assert per_type.get("plan", 0) == 0, f"expected 0 plan count, got {per_type.get('plan')}"
    assert per_type.get("prompt", 0) == 0, f"expected 0 prompt count, got {per_type.get('prompt')}"

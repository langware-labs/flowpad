"""Codex's effective skill inventory, including plugins and disabled entries."""

from flow_sdk.assets.asset_inventory import (
    AssetInventoryError,
    InventoryInputs,
    inventory_process,
    inventory_rows,
    inventory_spawn,
    json_request,
    skill_observations,
)


async def available_assets(inputs: InventoryInputs):
    argv, env = inventory_spawn(inputs, ["codex", "app-server", "--stdio"])
    async with inventory_process(argv, cwd=inputs.workdir, env=env) as probe:
        await json_request(probe, {
            "id": 1, "method": "initialize",
            "params": {"clientInfo": {"name": "flowpad-asset-inventory", "version": "1"}},
        }, response_id=1)
        response = await json_request(probe, {
            "id": 2, "method": "skills/list",
            "params": {"cwds": [inputs.workdir], "forceReload": True},
        }, response_id=2)
    entries = response.get("data")
    if not isinstance(entries, list) or len(entries) != 1:
        raise AssetInventoryError("Codex did not return the requested workspace inventory")
    # Invalid skill files are reported separately by Codex and are intentionally
    # absent from its usable skill list. Never resurrect them from the index.
    return skill_observations(inventory_rows(entries[0], "skills"), path_key="path")

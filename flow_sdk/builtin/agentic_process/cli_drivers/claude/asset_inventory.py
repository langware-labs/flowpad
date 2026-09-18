"""Native inventory probe; filesystem observations use shared asset utilities."""
import json

from flow_sdk.assets.asset_inventory import InventoryInputs, inventory_rows
from flow_sdk.assets.worker_inventory.claude import resolve_skills, resolve_subagents
from flow_sdk.builtin.agentic_process.cli_drivers.asset_inventory import (
    inventory_process,
    inventory_spawn,
    json_request,
)


async def available_assets(inputs: InventoryInputs):
    argv = ["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
    for directory in inputs.add_dirs:
        argv.extend(["--add-dir", directory])
    for directory in inputs.plugin_dirs:
        argv.extend(["--plugin-dir", directory])
    if inputs.settings_json:
        argv.extend(["--settings", json.dumps(inputs.settings_json)])
    if inputs.agents_json:
        argv.extend(["--agents", json.dumps(inputs.agents_json)])
    argv, env = inventory_spawn(inputs, argv)
    async with inventory_process(argv, cwd=inputs.workdir, env=env) as probe:
        response = await json_request(probe, {
            "type": "control_request", "request_id": "inventory", "request": {"subtype": "initialize"},
        }, response_id="inventory")
    return (resolve_skills(inputs, inventory_rows(response, "commands"))
            + resolve_subagents(inputs, inventory_rows(response, "agents")))

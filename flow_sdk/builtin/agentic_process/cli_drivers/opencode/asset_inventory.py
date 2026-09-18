"""OpenCode native probes, serialized around its shared user store."""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from flow_sdk.assets.asset_inventory import InventoryInputs
from flow_sdk.assets.worker_inventory.opencode import resolve_inventory
from flow_sdk.builtin.agentic_process.cli_drivers.asset_inventory import inventory_spawn, json_command

_inventory_lock = asyncio.Lock()


async def available_assets(inputs: InventoryInputs):
    # Native discovery initializes the same user store for every inputs.
    async with _inventory_lock:
        return await _available_assets(inputs)


async def _available_assets(inputs):
    argv, env = inventory_spawn(inputs, ["opencode", "debug", "skill"])
    paths = inputs.skill_paths
    # The read must never regenerate the live inputs's config: doing that
    # without its MCP/provider fragments would erase launch configuration.
    with TemporaryDirectory(prefix="flowpad-inventory-") as directory:
        if paths:
            config = Path(directory) / "opencode.json"
            config.write_text(json.dumps({"skills": {"paths": paths}}), encoding="utf-8")
            env["OPENCODE_CONFIG"] = str(config)
        # Both debug commands initialize OpenCode's SQLite store. Concurrent
        # startup demonstrably fails with "database is locked"; one probe must
        # finish initialization before the next opens that same store.
        response = await json_command(argv, cwd=inputs.workdir, env=env)
        config = await json_command([argv[0], "debug", "config"], cwd=inputs.workdir, env=env)
    return resolve_inventory(inputs, response, config)

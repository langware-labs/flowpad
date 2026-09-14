"""Copilot file-backed inventory, resolved by its native session configuration."""

from pathlib import Path

from flow_sdk.assets.asset_discovery import AssetSearchRoot
from flow_sdk.assets.asset_inventory import (
    AssetInventoryError,
    InventoryInputs,
    WorkerAsset,
    inventory_process,
    inventory_rows,
    inventory_spawn,
    json_request,
    skill_observations,
)
from flow_sdk.schema.types import EntityType


async def available_assets(inputs: InventoryInputs):
    # The SDK currently omits added-directory agents that the interactive CLI
    # demonstrably loads. Do not advertise this incomplete response as verified.
    for directory in inputs.add_dirs:
        root = AssetSearchRoot(asset_type=EntityType.SUBAGENT, path=Path(directory) / ".github/agents", recursive=True)
        if root.asset_paths():
            raise AssetInventoryError("Copilot cannot verify agents from added directories through its inventory API")
    options = inputs
    argv = ["copilot", "--headless", "--stdio"]
    # PTY launches allow the updater; headless launches use the pinned binary.
    # The same executable path can consequently run different native versions.
    if options.json_stream and options.no_auto_update:
        argv.append("--no-auto-update")
    for directory in inputs.add_dirs:
        argv.extend(["--add-dir", directory])
    argv, env = inventory_spawn(inputs, argv)
    async with inventory_process(argv, cwd=inputs.workdir, env=env) as probe:
        async def call(request_id, method, params):
            return await json_request(probe, {
                "jsonrpc": "2.0", "id": request_id, "method": method, "params": params,
            }, response_id=request_id, framed=True)

        session = await call(1, "session.create", {
            "workingDirectory": inputs.workdir,
            "clientName": "flowpad-asset-inventory",
            "enableConfigDiscovery": True,
            "additionalDirectories": inputs.add_dirs,
            "pluginDirectories": options.plugin_dirs,
        })
        session_id = session["sessionId"]
        try:
            skills = await call(2, "session.skills.list", {"sessionId": session_id})
            agents = await call(3, "session.agent.list", {"sessionId": session_id, "includeBuiltInAgents": False})
        finally:
            # This is an inventory session, not a conversation. Release it and
            # remove its persisted metadata so opening the UI creates no chats.
            await call(4, "session.destroy", {"sessionId": session_id})
            await call(5, "session.delete", {"sessionId": session_id})
    result = skill_observations(inventory_rows(skills, "skills"), path_key="path")
    for agent in inventory_rows(agents, "agents"):
        path = Path(agent["path"]) if agent.get("path") else None
        if path is not None and path.is_file():
            result.append(WorkerAsset(asset_type=EntityType.SUBAGENT, name=agent["name"], path=path.resolve()))
    return result

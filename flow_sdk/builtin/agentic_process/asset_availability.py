"""Select the process configuration that a native worker actually launched."""
from copy import deepcopy


async def inventory_process_view(process):
    """Inspect launch inputs for a live PTY, and current inputs for the next turn.

    Resolved mount directories are already in the worker snapshot. Re-expanding
    today's project folders or assistant default would silently inspect pending
    configuration instead of the inputs the running CLI actually received.
    """
    from flow_sdk.builtin.process_lifecycle import ProcessStatus
    from flow_sdk.fs_store.type_id import TypeId

    inspection = process.model_copy()
    if inspection.project_id:
        await inspection.get_project()
    if not (process.pty_mode and process.shell_id and process.status == ProcessStatus.RUNNING.value):
        return inspection
    snapshot = process.last_started_snapshot
    if not snapshot:
        return inspection
    inspection.__dict__["_asset_inventory_snapshot"] = True
    generic, worker = snapshot["generic"], snapshot["worker"]
    inspection.worker_type = generic["worker_type"]
    inspection.__dict__.pop("driver", None)
    inspection.workdir = generic["workdir"]
    inspection.cli_config = deepcopy(worker)
    inspection.additional_dirs = list(worker.get("add_dirs", generic.get("additional_dirs", [])))
    inspection.__dict__["_project_context_dirs"] = []
    inspection.load_flowpad_assistant = False  # its resolved path is already in add_dirs
    inspection.embedded_asset_refs = [TypeId(ref) for ref in generic.get("embedded_asset_refs", [])]
    inspection.embedded_subagent_ids = list(generic.get("embedded_subagent_ids", []))
    inspection.process_hook_events = list(generic.get("process_hook_events", []))
    inspection.llm_endpoint_typeid = generic.get("llm_endpoint_typeid")
    return inspection



def inventory_inputs(process, *, skill_paths=()):
    """Project runtime state into immutable input values for native adapters."""
    from flow_sdk.assets.asset_inventory import InventoryInputs
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        apply_worker_env,
        build_worker_spawn_env,
        resolve_worker_argv0,
    )
    from flow_sdk.instance_settings import get_instance_settings

    driver = process.driver
    options = driver.cli_options(process)
    env = build_worker_spawn_env(driver.name, apply_worker_env(dict(options.env_vars), process))
    return InventoryInputs(
        workdir=process.workdir,
        executable=resolve_worker_argv0(driver.name, [driver.name], env)[0], env=env,
        roots=driver.asset_search_roots(process), add_dirs=list(process.resolved_add_dirs),
        plugin_dirs=list(getattr(options, 'plugin_dirs', None) or []),
        settings_json=getattr(options, 'settings_json', None) or {},
        agents_json=getattr(options, 'agents_json', None) or {},
        json_stream=bool(getattr(options, 'json_stream', False)),
        no_auto_update=bool(getattr(options, 'no_auto_update', False)),
        agent=getattr(options, 'agent', None),
        claude_home=get_instance_settings().claude_home, skill_paths=list(skill_paths),
    )

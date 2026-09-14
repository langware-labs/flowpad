"""Process configuration adapters for the filesystem asset utilities."""

from flow_sdk.assets.catalog import AssetSource, add_source_dir


async def process_asset_sources(process):
    """Select scope folders; discovery belongs to AssetFolder."""
    from flow_sdk.instance_settings import get_instance_settings
    pairs, seen = [], set()
    settings = get_instance_settings()
    add_source_dir(pairs, seen, settings.user_home, AssetSource.USER_DIR)
    if process.project_id:
        if process.__dict__.get("_asset_inventory_snapshot"):
            # A live worker's mounted directories were frozen at launch.
            add_source_dir(pairs, seen, process.workdir, AssetSource.PROJECT_DIR)
        else:
            from flow_sdk.builtin.project import Project
            project = await Project.get_by_id(process.project_id)
            if project:
                add_source_dir(pairs, seen, project.fs_storage_mount_path, AssetSource.PROJECT_DIR)
                for path in project.include_dirs or []:
                    add_source_dir(pairs, seen, path, AssetSource.CONTEXT_DIR)
    add_source_dir(pairs, seen, process.workdir, AssetSource.WORKDIR)
    for path in process.additional_dirs or []:
        add_source_dir(pairs, seen, path, AssetSource.ADDITIONAL_DIR)
    if process.assistant_enabled:
        from flow_sdk.config import flowpad_assistant_canonical_root
        add_source_dir(pairs, seen, flowpad_assistant_canonical_root(), AssetSource.SYSTEM)
    return pairs

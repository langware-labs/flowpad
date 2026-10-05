"""Process configuration adapters for the filesystem asset utilities."""

from pathlib import Path

from flow_sdk.assets.catalog import AssetSource, add_source_dir


async def process_asset_sources(process):
    """Select scope folders; discovery belongs to AssetFolder."""
    from flow_sdk.instance_settings import get_instance_settings
    pairs, seen = [], set()
    settings = get_instance_settings()
    add_source_dir(pairs, seen, settings.user_home, AssetSource.USER_DIR)
    add_source_dir(pairs, seen, settings.user_asset_root, AssetSource.USER_DIR)
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
    from flow_sdk.config import flowpad_assistant_canonical_root
    assistant_root = flowpad_assistant_canonical_root()
    assistant_key = str(Path(assistant_root).expanduser().resolve()) if assistant_root else None
    for path in process.additional_dirs or []:
        # A live worker's launch snapshot folds the assistant root into its
        # --add-dir list; it is still the assistant, not a folder the user added.
        is_assistant = assistant_key is not None and str(Path(path).expanduser().resolve()) == assistant_key
        add_source_dir(pairs, seen, path, AssetSource.SYSTEM if is_assistant else AssetSource.ADDITIONAL_DIR)
    if process.assistant_enabled:
        add_source_dir(pairs, seen, assistant_root, AssetSource.SYSTEM)
    return pairs

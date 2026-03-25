import contextlib
import os
from pathlib import Path


def __root_folder():
    """
    Returns the root folder of the project. This is the folder containing the .git folder.
    """
    base_app_folder = "flowpad"  # No leading slash needed
    current_dir = Path(__file__).resolve().parent

    # Traverse up the directory tree
    while True:
        git_folder_path = current_dir / ".git"

        # Check if .git folder exists in the current directory
        if git_folder_path.is_dir():
            return str(current_dir / base_app_folder)

        # Check if the current directory is the base app folder
        if current_dir.name == base_app_folder:
            return str(current_dir)

        # Move up one directory level
        new_dir = current_dir.parent

        # If we've reached the filesystem root without finding .git, return current dir
        if new_dir == current_dir:
            return str(current_dir)
        current_dir = new_dir


ROOT_FOLDER = __root_folder()


@contextlib.contextmanager
def cwd_as_folder(folder):
    """
    A context manager that temporarily changes the current working directory to the provided folder.
    """
    cwd = os.getcwd()
    os.chdir(folder)
    try:
        yield
    finally:
        os.chdir(cwd)


def cwd_as_root_folder():
    return cwd_as_folder(ROOT_FOLDER)


def _get_plugins_folder():
    flowpad_folder = _get_flowpad_folder()
    plugins_folder = os.path.join(flowpad_folder, "plugins")
    return plugins_folder


def _get_hub_folder():
    flowpad_folder = _get_flowpad_folder()
    hub_folder = os.path.join(flowpad_folder, "hub")
    return hub_folder


def get_manifest_folder(name: str):
    plugin_folder = _get_plugins_folder()
    return os.path.join(plugin_folder, name)


def _get_builtin_folder():
    hub_folder = _get_hub_folder()
    builtin_entities_path = os.path.join(hub_folder, "builtin")
    return builtin_entities_path


def _get_flowpad_folder():
    return ROOT_FOLDER


def get_instances_folder():
    builtin_folder = _get_builtin_folder()
    builtin_entities_path = os.path.join(builtin_folder, "instances")
    return builtin_entities_path

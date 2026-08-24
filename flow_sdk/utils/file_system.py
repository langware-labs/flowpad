import contextlib
import os
import tempfile
from pathlib import Path

# Resolved once at import time — covers macOS /var/folders → /private/var/folders
_SYSTEM_TEMP_DIR = Path(tempfile.gettempdir()).resolve()

# Standard OS temp roots, independent of the current process's $TMPDIR. A server
# launched with the default $TMPDIR resolves only its own /var/folders subtree;
# these prefixes also catch /tmp and other-subtree temp paths that a *different*
# process (e.g. a test run) created. Matched against the RESOLVED path, so /tmp
# and /var/folders are compared in their /private/* canonical form on macOS.
# The ROOT itself is a temp location, not just its descendants: a project cwd of
# "/tmp" or "/private/tmp" once passed `is_valid_project_cwd` (only "/tmp/..."
# matched), so the indexer registered the whole system temp dir as a project and
# recursively walked every other process's scratch files from it.
_TEMP_ROOTS = ("/tmp", "/private/tmp", "/var/folders", "/private/var/folders")
_TEMP_PREFIXES = tuple(f"{root}/" for root in _TEMP_ROOTS)


def is_temp_path(path: Path | str) -> bool:
    """Return True if *path* lives in a system temporary location.

    The single, unified temp predicate. Matches BOTH the current process's
    resolved ``$TMPDIR`` subtree AND the standard OS temp roots — so e.g.
    ``/tmp/...`` is caught on macOS even though ``gettempdir()`` returns a
    ``/var/folders/...`` path there, and temp dirs created under a different
    ``$TMPDIR`` than this process's are still recognised.
    """
    try:
        resolved = Path(path).resolve()
    except (OSError, ValueError):
        return False
    posix = resolved.as_posix()
    # The roots themselves count, not just their descendants — one membership
    # test covers the static OS roots and this process's own resolved $TMPDIR.
    if posix in (*_TEMP_ROOTS, _SYSTEM_TEMP_DIR.as_posix()):
        return True
    if posix.startswith(_TEMP_PREFIXES):
        return True
    try:
        return resolved.is_relative_to(_SYSTEM_TEMP_DIR)
    except (OSError, ValueError):
        return False


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

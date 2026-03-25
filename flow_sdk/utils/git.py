import subprocess
from pathlib import Path

from .file_system import ROOT_FOLDER

commit_hash = None  # Global variable to store the commit hash


def git_root_folder():
    app_root = ROOT_FOLDER
    app_root = Path(app_root).resolve().parent
    return str(app_root)


def git_commit_hash():
    global commit_hash
    if commit_hash is not None:
        return commit_hash
    result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True, cwd=git_root_folder()
    )
    commit_hash = result.stdout.strip()
    return commit_hash

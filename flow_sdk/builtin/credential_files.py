"""Where a ``file`` credential variable's content lives on this machine.

A ``file`` variable (``CredentialVarKind.FILE`` — a service-account key JSON) is
kept as a file under the instance, never in a project tree, readable by this user
only. The scope's store (``.env.local`` or the vault) holds the variable as that
file's PATH, so presence, injection into spawned processes, ``check`` and delete
are the same as for any value.

The path is a pure function of the credential, its scope, the environment and
the variable, so the status can tell a file is there without reading any value.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.credential_store import CredentialScope

_DIR = "credential-files"


def _root() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / _DIR


def credential_file(spec: "Credential", scope: "CredentialScope", env_var: str, environment: str) -> Path:
    """``<instance>/credential-files/<scope>[-<project>]/<credential id>/<environment>/<VAR>``."""
    where = scope.scope if not scope.project_id else f"{scope.scope}-{scope.project_id}"
    return _root() / where / str(spec.id) / environment / env_var


def write_credential_file(path: Path, content: str) -> None:
    """Write ``content`` to ``path``, this user only (0600, folders 0700), replacing it atomically."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staged = path.with_name(f".{path.name}.tmp")
    fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(content)
    os.replace(staged, path)


def remove_credential_files(spec: "Credential") -> None:
    """Every file ``spec`` keeps, in every scope and environment."""
    root = _root()
    if not root.is_dir():
        return
    for scope_dir in root.iterdir():
        shutil.rmtree(scope_dir / str(spec.id), ignore_errors=True)

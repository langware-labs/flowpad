"""Runtime-only, process-owned credential files for native worker authentication."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory

_owned: dict[str, list[TemporaryDirectory]] = {}


@dataclass(frozen=True)
class CredentialArtifact:
    env_var: str
    content: str = field(repr=False)


def materialize(process, artifact: CredentialArtifact) -> dict[str, str]:
    """Create a fresh private artifact; retain ownership until this worker exits."""
    directory = TemporaryDirectory(prefix="flowpad-worker-credential-")
    try:
        os.chmod(directory.name, 0o700)
        path = Path(directory.name) / "credential.json"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(artifact.content)
    except BaseException:
        directory.cleanup()
        raise
    _owned.setdefault(str(process.id), []).append(directory)
    return {artifact.env_var: str(path)}


def cleanup(process) -> None:
    """Only call after worker termination; never delete paths supplied by a caller."""
    process.__dict__.pop("_spawn_api_auth", None)
    process.__dict__.pop("_prepared_api_auth", None)
    cleanup_id(str(process.id))


def cleanup_id(process_id: str) -> None:
    for directory in _owned.pop(str(process_id), []):
        directory.cleanup()


def on_exit_cleanup(process, callback):
    """Capture this launch's artifacts: a late old callback cannot delete a new launch's."""
    process_id = str(process.id)
    artifacts = tuple(_owned.get(process_id, ()))
    binding = process.__dict__.get("_spawn_api_auth")

    def on_exit(code):
        if process.__dict__.get("_spawn_api_auth") is binding:
            process.__dict__.pop("_spawn_api_auth", None)
        for directory in artifacts:
            directory.cleanup()
            current = _owned.get(process_id, [])
            if directory in current:
                current.remove(directory)
            if not current:
                _owned.pop(process_id, None)
        callback(code)

    return on_exit

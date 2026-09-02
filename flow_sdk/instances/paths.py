"""Sole path derivation for instance management.

Every path this package touches is derived here, and every per-instance path is
derived through ``BaseInstanceSettings`` — the single source of truth for the
``<flow_home>/instances/<name>/`` layout, whose module docstring explicitly
forbids re-deriving ``~/.flow`` at call sites.

``validate_name`` runs before any path is built from a caller-supplied name. It
is the traversal guard: ``reset ../../etc`` must fail here, not at ``rmtree``.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .errors import NameInvalid

# flow_sdk/instances/paths.py → repo root
REPO_ROOT = Path(__file__).resolve().parents[2]

# Instance names are used as directory names, env-file infixes, and vite
# `--mode` values. Lowercase alnum plus `.`/`_`/`-`, never leading with a
# separator (a leading `-` would be parsed as a flag by the shell callers).
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

# Sibling directories under `<flow_home>/instances/` that are NOT instances.
# `reset --all` enumerates that directory, so these must never be swept.
NON_INSTANCE_DIRS = frozenset({"global", "capability-installs"})

# Instances the sweeping commands (gc / reap / reset) refuse to touch unless
# explicitly authorized. Preserved verbatim from instance_ctl.sh's default so a
# refactor cannot silently widen the blast radius. NOTE: this gates gc/reap/reset
# only — an explicit `kill dev-1` must keep working (2dev-users-setup relies on it).
DEFAULT_PROTECTED = ("prod", "oss", "dev-1", "dev-2")


def validate_name(name: str) -> str:
    """Return ``name`` if it is a legal instance name, else raise ``NameInvalid``.

    Call this before deriving any path from caller input. Rejects the empty
    string, ``.``/``..``, anything containing a separator, embedded whitespace
    (which would smuggle a second token past a space-split protected list),
    glob characters, and leading dashes.
    """
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise NameInvalid(
            f"invalid instance name {name!r}: expected lowercase alphanumeric "
            "with '.', '_' or '-', 1-64 chars, not starting with a separator"
        )
    return name


def protected_instances() -> frozenset[str]:
    """Names that gc / reap / reset refuse to touch without explicit authorization."""
    raw = os.environ.get("PROTECTED_INSTANCES")
    if raw is None:
        return frozenset(DEFAULT_PROTECTED)
    return frozenset(tok for tok in raw.split() if tok)


def repo_root() -> Path:
    return REPO_ROOT


#: Memoized ``(FLOW_HOME value) → instances root``.
#:
#: Every path here used to build a fresh ``BaseInstanceSettings``, which
#: re-resolves flow_home, claude_home, codex_home, records_root, db_path and
#: port. A single ``status`` on a 286-instance machine did that 1,079 times —
#: 178ms of a 269ms command, two thirds of the total, and more than the process
#: scan itself. The cache is keyed on the env var rather than unconditional, so
#: a test that redirects ``FLOW_HOME`` still gets a fresh answer.
_ROOT_CACHE: tuple[str | None, Path] | None = None


def _roots() -> Path:
    global _ROOT_CACHE
    key = os.environ.get("FLOW_HOME")
    if _ROOT_CACHE is not None and _ROOT_CACHE[0] == key:
        return _ROOT_CACHE[1]

    from flow_sdk.instance_settings.base_settings import BaseInstanceSettings

    root = BaseInstanceSettings.from_env("prod").instances_root
    _ROOT_CACHE = (key, root)
    return root


def flow_home() -> Path:
    return _roots().parent


def instances_root() -> Path:
    return _roots()


def instance_dir(name: str) -> Path:
    """``<flow_home>/instances/<name>``.

    The join is the same one ``BaseInstanceSettings`` performs, and targets the
    named instance regardless of the caller's ambient ``FLOW_INSTANCE``.
    """
    return _roots() / validate_name(name)


def launcher_path(name: str) -> Path:
    """The launcher registry. Filename is a public contract — ~12 readers plus
    four vitest source-policy tests pin the literal path expression."""
    return instance_dir(name) / "launcher.json"


# The three backend-owned control files below take their names from
# BaseInstanceSettings rather than re-hardcoding them: reconcile deletes files by
# these names, so a rename there must not silently make the sweep a no-op.
def server_json_path(name: str) -> Path:
    return instance_dir(name) / _SERVER_FILENAMES["json"]


def server_lock_path(name: str) -> Path:
    return instance_dir(name) / _SERVER_FILENAMES["lock"]


def server_pid_path(name: str) -> Path:
    return instance_dir(name) / _SERVER_FILENAMES["pid"]


def service_lease_lock_path(name: str) -> Path:
    """Immediate lifecycle lock for temporary service ownership."""
    return instance_dir(name) / "connection-service.lock"


def connection_provider_lock_path(name: str, provider: str) -> Path:
    """Serialize one provider's authorization session inside an instance."""
    safe_provider = validate_name(provider.strip().lower())
    return instance_dir(name) / f"connection-{safe_provider}.lock"


def _server_filenames() -> dict[str, str]:
    from flow_sdk.instance_settings.base_settings import BaseInstanceSettings

    s = BaseInstanceSettings.from_env("prod")
    return {
        "json": s.server_json_path.name,
        "lock": s.server_lock_path.name,
        "pid": s.server_pid_path.name,
    }


class _LazyNames(dict):
    """Resolve the backend's control-file names on first use, then cache."""

    def __missing__(self, key: str) -> str:
        self.update(_server_filenames())
        return dict.__getitem__(self, key)


_SERVER_FILENAMES = _LazyNames()


def backend_log(name: str) -> Path:
    return instance_dir(name) / "launcher-backend.log"


def frontend_log(name: str) -> Path:
    return instance_dir(name) / "launcher-frontend.log"


def env_file(name: str) -> Path:
    """``<repo_root>/.env.<name>.local``.

    Repo root, not ``ui/`` — vite's ``envDir`` is ``path.resolve(__dirname, '..')``
    (``ui/vite.config.ts``), so this is the only directory vite reads env from
    even though the dev server is started from ``ui/``.
    """
    return REPO_ROOT / f".env.{validate_name(name)}.local"


def ports_ledger_path() -> Path:
    """``<flow_home>/instances/ports.json`` — the port→instance lease table."""
    return instances_root() / "ports.json"


def ports_ledger_lock() -> Path:
    return instances_root() / "ports.json.lock"


def known_instance_dirs() -> list[Path]:
    """Every directory under ``instances/`` that could be an instance.

    Excludes the non-instance siblings and anything whose name is not a legal
    instance name, so a stray file or a hand-made directory can never become a
    sweep target.
    """
    root = instances_root()
    if not root.is_dir():
        return []
    out = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name in NON_INSTANCE_DIRS:
            continue
        try:
            validate_name(child.name)
        except NameInvalid:
            continue
        out.append(child)
    return out

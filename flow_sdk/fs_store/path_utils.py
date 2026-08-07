"""Path normalization for asset_ref storage and folder-prefix queries.

`canonical_posix_path` is the single rule the entity DB uses to canonicalize
asset paths so that the lex-range trick used by `Entity.assets_by_path`
matches stored values across macOS, Linux, and Windows on the same host.
"""

from __future__ import annotations

import ntpath
import os
import tempfile
import unicodedata
from pathlib import Path, PureWindowsPath


def canonical_posix_path(p: Path | str) -> str:
    """Canonical POSIX form of a filesystem path.

    - ``Path.resolve()`` follows symlinks and returns the FS-canonical case
      on macOS APFS and Windows NTFS (case-insensitive but case-preserving).
    - ``as_posix()`` collapses ``\\`` vs ``/`` so Windows paths sort like
      ``C:/Users/foo`` and the half-open range trick works.
    - ``unicodedata.normalize("NFC", ...)`` defuses macOS APFS NFD vs NFC
      pitfalls; no-op for ASCII paths.
    """
    return unicodedata.normalize("NFC", Path(p).resolve().as_posix())


def _path_policy_key(path: Path | str) -> tuple[str, str, str] | None:
    """Return ``(flavour, canonical, root)`` without mangling Windows paths.

    ``Path("C:\\work")`` is relative on POSIX, so path-safety policy cannot
    use the host ``Path`` flavour for worker metadata written on another OS.
    """
    raw = os.fspath(path).strip()
    if not raw or "\x00" in raw:
        return None
    drive, tail = ntpath.splitdrive(raw)
    is_windows_drive = len(drive) == 2 and drive[1] == ":" and tail.startswith(("\\", "/"))
    is_unc = drive.startswith(("\\\\", "//"))
    if is_windows_drive or is_unc:
        pure = PureWindowsPath(ntpath.normpath(raw))
        canonical = unicodedata.normalize("NFC", pure.as_posix()).rstrip("/")
        root = PureWindowsPath(pure.anchor).as_posix().rstrip("/")
        return "windows", canonical.casefold(), root.casefold()
    # A drive-less Windows-rooted path (``\foo``) is not a stable absolute
    # project identity. A leading forward slash continues through POSIX below.
    if raw.startswith("\\") or drive:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        return None
    try:
        canonical = canonical_posix_path(candidate).rstrip("/") or "/"
    except (OSError, ValueError):
        return None
    return "posix", canonical, "/"


def _same_flavour_key(path: Path | str, flavour: str) -> str | None:
    keyed = _path_policy_key(path)
    if keyed is None or keyed[0] != flavour:
        return None
    return keyed[1]


def _same_or_under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _temp_root_keys(flavour: str) -> frozenset[str]:
    raw_roots = (
        tempfile.gettempdir(),
        os.environ.get("TEMP", ""),
        os.environ.get("TMP", ""),
        os.environ.get("TMPDIR", ""),
    )
    return frozenset(root for raw_root in raw_roots if raw_root and (root := _same_flavour_key(raw_root, flavour)))


def is_protected_path(path: Path | str | None) -> bool:
    """Return whether ``path`` must never be recursively deleted.

    The check is host-independent: Windows drive/UNC paths retain Windows
    semantics even when inspected on POSIX. Invalid, relative, and otherwise
    unclassifiable paths are protected so destructive callers fail closed.

    Protected paths are filesystem roots, the configured user home and its
    ancestors, the agent workspace container itself, exact temporary roots,
    instance/legacy record stores, and SDK-shipped system projects. Descendant
    project folders remain unprotected.
    """
    if path is None:
        return True
    keyed = _path_policy_key(path)
    if keyed is None:
        return True
    # SDK-shipped system projects live inside the INSTALLED package
    # (<site-packages>/flow_sdk/system_projects/<name>), which none of the
    # roots below cover — so without this, deleting the Flowpad Assistant
    # rmtree's the shipped docs/skills/agents out of the user's own install.
    # It belongs here rather than at one deleter so EVERY destructive path
    # that consults this policy is covered.
    from flow_sdk.config import is_system_project_path  # noqa: PLC0415

    if is_system_project_path(path):
        return True
    flavour, candidate, filesystem_root = keyed
    if candidate == filesystem_root:
        return True

    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        settings = get_instance_settings()
    except Exception:
        settings = None

    home = (
        _same_flavour_key(settings.user_home, flavour)
        if settings is not None and getattr(settings, "user_home", None)
        else None
    )
    # Direction matters: candidate containing HOME is the dangerous broad-root
    # shape. HOME descendants are intentionally valid.
    if home and _same_or_under(home, candidate):
        return True

    try:
        from flow_sdk.config import AGENT_MOUNT_FOLDER, agent_workspace_root  # noqa: PLC0415

        agent_roots = (AGENT_MOUNT_FOLDER, agent_workspace_root())
    except Exception:
        agent_roots = ()
    for raw_root in agent_roots:
        root = _same_flavour_key(raw_root, flavour)
        if root and candidate == root:
            return True

    if candidate in _temp_root_keys(flavour):
        return True

    internal_roots: list[Path | str] = []
    if settings is not None:
        for attr in ("records_root", "records_data_dir"):
            value = getattr(settings, attr, None)
            if value:
                internal_roots.append(value)
    for raw_root in internal_roots:
        root = _same_flavour_key(raw_root, flavour)
        if root and _same_or_under(candidate, root):
            return True
    if home:
        for suffix in (
            ".flow/records",
            ".flow/dev_records",
            "flow/records",
            "flow/dev_records",
        ):
            legacy_root = home.rstrip("/") + "/" + suffix
            if _same_or_under(candidate, legacy_root):
                return True
    return False


def is_valid_project_cwd(
    path: Path | str | None,
    *,
    include_temp: bool = False,
) -> bool:
    """Canonical policy gate for a worker/discovered project cwd.

    Rejects every protected path plus temporary-directory descendants unless
    ``include_temp`` is explicitly requested by a diagnostic/test caller.
    """
    if is_protected_path(path):
        return False
    if path is None:
        return False

    keyed = _path_policy_key(path)
    if keyed is None:
        return False
    flavour, candidate, _filesystem_root = keyed

    if not include_temp:
        # The host-path helper must only inspect paths in the host's POSIX
        # flavour. On POSIX, ``Path("C:/work")`` is relative and resolves
        # beneath the current working directory (often /tmp in tests), which
        # falsely rejects a valid Windows project cwd. Windows paths are
        # checked by the flavour-preserving temp-root keys below.
        if flavour == "posix":
            from flow_sdk.utils.file_system import is_temp_path  # noqa: PLC0415

            if is_temp_path(path):
                return False
        if any(_same_or_under(candidate, root) for root in _temp_root_keys(flavour)):
            return False
    return True


def is_valid_project_mount(
    path: Path | str | None,
    *,
    include_temp: bool = False,
) -> bool:
    """Canonical policy gate for a project mount used in OWNERSHIP lookups.

    Deliberately distinct from ``is_valid_project_cwd``. That one answers "may
    a worker run here / may this become a discovered cwd", and it fails closed
    through ``is_protected_path`` — whose job is "must never be recursively
    deleted". The two questions only *look* alike, and conflating them is a
    real bug: an SDK-shipped system project is protected from deletion (it
    lives inside the installed package), so the delete gate rejects it, so it
    vanished from ``load_project_mounts`` and every file under
    ``flow_sdk/system_projects/<name>/`` was attributed to the nearest
    *deletable* ancestor project instead — typically the checkout containing
    the install.

    Undeletable does not mean unowned. A system project mount is a precise,
    legitimate owner, so it is admitted here while remaining fully protected
    from every destructive caller.
    """
    from flow_sdk.config import is_system_project_path  # noqa: PLC0415

    if path is not None and is_system_project_path(path):
        return True
    return is_valid_project_cwd(path, include_temp=include_temp)


def ancestors_of(p: Path | str) -> list[str]:
    """Ancestor directories of ``p`` in canonical posix form, deepest first,
    excluding the filesystem root.

    Canonicalizes through ``canonical_posix_path`` first so the returned keys
    match stored ``asset_ref`` values (which are written through the same
    rule) — the containment counterpart of ``is_path_under``.
    """
    from pathlib import PurePosixPath

    canon = canonical_posix_path(p)
    return [a.as_posix() for a in PurePosixPath(canon).parents if a.as_posix() != "/"]


def is_path_under(path: str, root: str) -> bool:
    """Segment-safe containment: ``path`` IS ``root`` or lives inside it.

    Pure string check over already-canonical posix paths (see
    ``canonical_posix_path``) — ``/a/bc`` is NOT under ``/a/b``. The single
    containment predicate shared by the nested-project walk dedup
    (``real_project_cwd_fn._dedup_nested``) and the deepest-project-wins
    association (``deepest_project_id_for_path``) so the two can never drift.
    """
    r = root.rstrip("/")
    p = path.rstrip("/")
    return p == r or p.startswith(r + "/")

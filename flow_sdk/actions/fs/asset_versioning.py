"""Storage-action adapter for filesystem asset versioning."""
import logging

from flow_sdk.assets.versioning import _bump_version_and_commit

logger = logging.getLogger(__name__)

def _real_path(storage, vfs_abs_path: str) -> str | None:
    """Resolve the real on-disk path for a local storage driver, else None."""
    resolver = getattr(storage, "_local_full_path", None)
    if not callable(resolver):
        return None
    try:
        return resolver(vfs_abs_path)
    except Exception:  # noqa: BLE001
        return None


async def autoversion_commit_local(storage, vfs_abs_path: str, content: str, *, real_path: str | None = None) -> None:
    """Bump frontmatter ``version`` and commit on save, for frontmatter-bearing
    files in a git repo on local storage. The bump is written directly to the real
    path (not back through the ``write`` action), so it never re-enters this hook.
    """
    try:
        if not isinstance(content, str):
            return
        real = real_path if real_path is not None else _real_path(storage, vfs_abs_path)
        if not real:
            return  # remote/sandbox storage — no local git tree
        await _bump_version_and_commit(real, content)
    except Exception as e:  # noqa: BLE001 — auto-versioning must never break a save
        logger.warning("[asset-version] auto-commit skipped (non-fatal): %s", e)

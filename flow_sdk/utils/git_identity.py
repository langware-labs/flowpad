"""Canonical git-remote identity — one key builder, one minter, one URL parser.

The deterministic identity for "a git repo" is text, not an entity:
``git:{provider}:{owner}/{name}`` with all three components case-folded
(providers route owner/name case-insensitively — two senders typing
``Foo/Bar`` vs ``foo/bar`` must converge). Display case is preserved on the
entity fields; only the key folds.

Note: ``flow_sdk/utils/git.py:repo_id`` is an older, separate deterministic
repo id (``uuid5(NAMESPACE_DNS, "repo:{full_name}")``) used by the
task-receive collection matching. The two id-spaces deliberately coexist —
do not unify without migrating task manifests.
"""

from __future__ import annotations

import re
import uuid
from urllib.parse import urlparse

from flow_sdk.fs_store.identifier import mint_uuid

# Same owner/name shape as utils/git.py:git_repo_full_name — handles
# https, ssh:// and scp-style remotes, with an optional trailing ".git".
_FULL_NAME_RE = re.compile(r"[:/]([^/:\s]+/[^/:\s]+?)(?:\.git)?/?$")

_HOST_PROVIDERS = {
    "github.com": "github",
    "gitlab.com": "gitlab",
    "bitbucket.org": "bitbucket",
}

# Inverse of _HOST_PROVIDERS — short provider name back to its canonical host.
_PROVIDER_HOSTS = {provider: host for host, provider in _HOST_PROVIDERS.items()}


def _strip_git_suffix(name: str) -> str:
    return name[:-4] if name.endswith(".git") else name


def canonical_git_remote_key(provider: str, owner: str, name: str) -> str:
    """The ONE canonical key for a git remote: ``git:{provider}:{owner}/{name}``.

    Components are stripped + case-folded; a defensive trailing ``.git`` is
    removed from the name. Every consumer (GitRemote minting, file-entity
    identity keys) must build keys through here.
    """
    p = provider.strip().lower()
    o = owner.strip().lower()
    n = _strip_git_suffix(name.strip().lower())
    return f"git:{p}:{o}/{n}"


def mint_git_remote_id(provider: str, owner: str, name: str) -> str:
    """Deterministic uuid5 entity id for a git remote (policy: mint_uuid only)."""
    return mint_uuid(key=canonical_git_remote_key(provider, owner, name), namespace=uuid.NAMESPACE_URL)


def git_remote_https_url(provider: str, owner: str, name: str) -> str:
    """Rebuild an https clone URL from a remote's ``(provider, owner, name)``.

    The inverse of ``parse_git_remote_url`` for the known providers: a short
    provider name maps back to its host; an unknown provider is itself the
    host (``parse_git_remote_url`` returns the bare hostname for those). Used
    by the receiver of a shared GitBranch to reconstruct the URL to clone.
    """
    host = _PROVIDER_HOSTS.get(provider.strip().lower(), provider.strip())
    return f"https://{host}/{owner}/{_strip_git_suffix(name)}.git"


def _host_of(url: str) -> str:
    """Hostname of an https/ssh/scp-style git remote URL, lowercased."""
    u = url.strip()
    if "://" in u:
        return (urlparse(u).hostname or "").lower()
    # scp-style: [user@]host:owner/repo(.git)
    m = re.match(r"^(?:[^@/\s]+@)?([^:/\s]+):", u)
    return m.group(1).lower() if m else ""


def parse_git_remote_url(url: str) -> tuple[str, str, str] | None:
    """Parse a remote URL into ``(provider, owner, name)``; None when unusable.

    Provider is the known short name for github/gitlab/bitbucket hosts, else
    the bare hostname. Owner/name keep their on-URL case (the canonical key
    folds them; entity fields keep display case).
    """
    if not url or not url.strip():
        return None
    host = _host_of(url)
    if not host:
        return None
    m = _FULL_NAME_RE.search(url.strip())
    if not m:
        return None
    full_name = m.group(1)
    owner, _, name = full_name.partition("/")
    name = _strip_git_suffix(name)
    if not owner or not name or owner.lower() == host:
        return None
    return (_HOST_PROVIDERS.get(host, host), owner, name)

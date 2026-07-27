"""Canonical git origin identity — one repo key builder and one URL parser.

The deterministic identity for "a git repo" is text, not an entity:
``git:{provider}:{owner}/{name}`` with all three components case-folded
(providers route owner/name case-insensitively — two senders typing
``Foo/Bar`` vs ``foo/bar`` must converge). Display case is preserved on the
origin fields; only the key folds.

``GitOrigin`` is the canonical structured pointer whenever a payload needs to
refer to a git resource. Lower-level helpers may still accept concrete clone
URLs for running git commands after that pointer has been resolved.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote, urlparse

# Same owner/name shape as utils/git.py:git_repo_full_name — handles
# https, ssh:// and scp-style remotes, with an optional trailing ".git".
_FULL_NAME_RE = re.compile(r"[:/]([^/:\s]+/[^/:\s]+?)(?:\.git)?/?$")

_HOST_PROVIDERS = {
    "github.com": "github",
    "gitlab.com": "gitlab",
    "bitbucket.org": "bitbucket",
}

_PROVIDER_HOSTS = {provider: host for host, provider in _HOST_PROVIDERS.items()}


def _strip_git_suffix(name: str) -> str:
    return name[:-4] if name.endswith(".git") else name


def canonical_git_origin_repo_key(provider: str, owner: str, name: str) -> str:
    """Canonical repo key used by GitOrigin: ``git:{provider}:{owner}/{name}``.

    Components are stripped + case-folded; a defensive trailing ``.git`` is
    removed from the name. Every consumer that needs repo-scoped identity must
    build keys through here.
    """
    p = provider.strip().lower()
    o = owner.strip().lower()
    n = _strip_git_suffix(name.strip().lower())
    return f"git:{p}:{o}/{n}"


def _host_of(url: str) -> str:
    """Hostname of an https/ssh/scp-style git remote URL, lowercased."""
    u = url.strip()
    if "://" in u:
        return (urlparse(u).hostname or "").lower()
    # scp-style: [user@]host:owner/repo(.git)
    m = re.match(r"^(?:[^@/\s]+@)?([^:/\s]+):", u)
    return m.group(1).lower() if m else ""


def parse_git_origin_url(url: str) -> tuple[str, str, str] | None:
    """Parse a git origin URL into ``(provider, owner, name)``; None when unusable.

    Provider is the known short name for github/gitlab/bitbucket hosts, else
    the bare hostname. Owner/name keep their on-URL case (the canonical key
    folds them; GitOrigin keeps display case).
    """
    if not url or not url.strip():
        return None
    raw = url.strip()
    parsed = urlparse(raw) if "://" in raw else None
    if parsed is not None and parsed.scheme == "file":
        path = Path(unquote(parsed.path or ""))
        if not path.name:
            return None
        return ("file", path.parent.as_posix(), _strip_git_suffix(path.name))

    host = _host_of(raw)
    if not host:
        return None
    m = _FULL_NAME_RE.search(raw)
    if not m:
        return None
    full_name = m.group(1)
    owner, _, name = full_name.partition("/")
    name = _strip_git_suffix(name)
    if not owner or not name or owner.lower() == host:
        return None
    return (_HOST_PROVIDERS.get(host, host), owner, name)


def git_origin_clone_url(provider: str, owner: str, name: str) -> str:
    """Build the canonical HTTPS clone URL for a GitOrigin repo coordinate."""
    if provider.strip().lower() == "file":
        base = Path(owner.strip())
        leaf = _strip_git_suffix(name.strip())
        plain = base / leaf
        path = plain if plain.exists() else base / f"{leaf}.git"
        return path.resolve().as_uri()
    host = _PROVIDER_HOSTS.get(provider.strip().lower(), provider.strip())
    return f"https://{host}/{owner}/{_strip_git_suffix(name)}.git"

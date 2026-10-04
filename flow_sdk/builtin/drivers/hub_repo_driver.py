"""Hub-repo origin driver — the ``kind="hub_repo"`` behavior for the FSOrigin registry.

``materialize`` brings a project's hub-hosted repository to this machine, read
with the user's hub token: with no ``preferred_root``, a cache clone under the
instance directory, synced to the hub on every call; with one (a shared project's
own folder), a working checkout that is only ever fast-forwarded. The caller
joins ``rel_path`` onto the returned root to reach the asset
(``project_manifest._source_root``). Nothing else writes to the cache, so it is
always an exact copy of the hub.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from flow_sdk.fs_store.origin.fs_origin import FSOrigin


def _received_root(repo_id: str) -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(get_instance_settings().instance_dir) / "hub_git" / "received" / repo_id


class HubRepoOriginDriver:
    kind = "hub_repo"

    def key(self, origin: FSOrigin) -> str:
        return origin.key()

    async def materialize(
        self,
        origin: FSOrigin,
        *,
        preferred_root: Optional[Path] = None,
        preferred_project_id: Optional[str] = None,
        token: Optional[str] = None,
    ) -> tuple[Path, Optional[str]]:
        from flow_sdk.assets.hub_repo_sync import HubRepoCheckout, HubRepoMirror  # noqa: PLC0415
        from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_graph_url  # noqa: PLC0415

        repo_id = origin.repo_id  # type: ignore[attr-defined]
        clone_url = hub_graph_url("git_repo", repo_id, "git")
        hub_token = token or resolve_hub_api_key(require_live=True)
        if not clone_url or not hub_token:
            raise RuntimeError("the hub is not reachable from this desktop (not logged in to the cloud)")
        if preferred_root is not None:
            # A place the caller owns (a shared project's folder): a working checkout,
            # cloned once and only fast-forwarded — never the cache's reset/clean.
            await HubRepoCheckout(root=preferred_root, clone_url=clone_url, branch="main", token=hub_token).checkout()
            return preferred_root, preferred_project_id
        root = _received_root(repo_id)
        await HubRepoMirror(root=root, clone_url=clone_url, branch="main", token=hub_token).sync()
        return root, preferred_project_id

    def matches(self, origin: FSOrigin, local_path: Path) -> bool:
        return False

    async def detect(self, asset_root: Path) -> Optional[FSOrigin]:
        return None

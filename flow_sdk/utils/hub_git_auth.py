"""Ephemeral, URL-scoped credentials for working checkouts of hub repositories."""

from __future__ import annotations

import re
from typing import Mapping

from flow_sdk.utils.git_folder import GitFolder


async def hub_git_environment(folder: GitFolder, env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Resolve the current login per operation; never persist it in git config."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key
    from flow_sdk.cloud_client.transport.hub_http import hub_graph_url

    result = dict(env or {})
    base = hub_graph_url("git_repo")
    if not base:
        return result
    configured = await folder.git("config", "--get-regexp", r"^remote\..*\.(url|pushurl)$")
    if not configured.ok:
        return result
    pattern = re.compile(re.escape(base.rstrip("/")) + r"/[0-9a-fA-F-]{36}/git/?$")
    entries = (line.split(None, 1) for line in configured.stdout.splitlines())
    urls = {parts[1] for parts in entries if len(parts) == 2 and pattern.fullmatch(parts[1])}
    if not urls:
        return result
    token = resolve_hub_api_key(require_live=True)
    if not token:
        return result
    count = int(result.get("GIT_CONFIG_COUNT", "0"))
    for url in sorted(urls):
        for key, value in (
            (f"http.{url}.extraHeader", f"Authorization: Bearer {token}"),
            (f"credential.{url}.helper", ""),
            (f"http.{url}.followRedirects", "false"),
        ):
            result[f"GIT_CONFIG_KEY_{count}"] = key
            result[f"GIT_CONFIG_VALUE_{count}"] = value
            count += 1
    result["GIT_CONFIG_COUNT"] = str(count)
    return result

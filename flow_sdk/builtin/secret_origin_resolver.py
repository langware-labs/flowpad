"""The one place a project's declared secrets become values.

Two transports need this — a worker's process env dict on this machine, and a
``list[FlowEnv]`` prefixed onto commands running on a compute node — but they
must not be two resolutions. One implementation, two thin adapters, so a change
to how a secret resolves cannot apply to one path and miss the other.

``only`` is the node attachment filter. ``None`` means no restriction recorded,
which is what an uncurated node reports, so nothing changes for anyone who has
never opened the attach UI.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from pydantic import SecretStr

logger = logging.getLogger(__name__)


async def resolve_project_secrets(
    project,
    *,
    only: Optional[Iterable[str]] = None,
    **context: Any,
) -> dict[str, SecretStr]:
    """Resolve every declared secret on ``project`` that ``only`` permits.

    Per-secret failures are swallowed and logged by NAME — a missing or
    unresolvable secret must never take down a spawn, and the value must never
    reach a log line.
    """
    from flow_sdk.builtin.secret_origin import SecretOrigin  # noqa: PLC0415
    from flow_sdk.builtin.secret_origin_driver import get_secret_origin_driver  # noqa: PLC0415

    allowed = None if only is None else set(only)
    resolved: dict[str, SecretStr] = {}
    seen: set[str] = set()

    for bucket in ("private", "shared"):
        for tid in project.context_of_type("secret_origin", bucket=bucket):
            if str(tid) in seen:
                continue
            seen.add(str(tid))
            entry = project.get_context_entry_data(tid) or {}
            env_var = (entry.get("env_var") or "").strip()
            secret = await SecretOrigin.get_by_id(tid.id)
            if secret is None:
                continue
            env_var = env_var or (secret.env_var or "").strip()
            if not env_var or env_var in resolved:
                continue
            if allowed is not None and env_var not in allowed:
                continue
            try:
                value = await get_secret_origin_driver(secret.locator.kind).resolve(
                    secret.locator, project=project, secret_origin=secret, **context
                )
            except Exception as e:  # noqa: BLE001
                logger.debug("[secrets] could not resolve %s: %s", env_var, e)
                continue
            if value is not None:
                resolved[env_var] = value
    return resolved


async def attached_env_vars_for(project) -> Optional[list[str]]:
    """The node filter for ``project``, or ``None`` when nothing is recorded.

    Resolved through the node that actually runs this project's work; locally
    that is always the ``@local`` singleton, which is why the map is keyed by
    project rather than being a flat list.
    """
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    try:
        node = await ComputeNode.get_local(create=False)
    except Exception:  # noqa: BLE001
        return None
    if node is None:
        return None
    return node.attached_env_vars(str(project.id))

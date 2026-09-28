"""A saved Deployment for credential tests: an agent's cloud placement in ``environment``, optionally
with its own binding (``DeploymentSecretsSpec`` fields as keywords)."""

from __future__ import annotations

AGENT = "agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d"


async def make_deployment(environment: str, name: str = "qa", **secrets):
    from flow_sdk.builtin.deployment import KIND_AGENT, Deployment  # noqa: PLC0415
    from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec  # noqa: PLC0415

    row = Deployment(
        name=f"{name} ({environment})",
        kind=KIND_AGENT,
        parent_type_id=AGENT,
        target={"provider": "e2b", "scope": "machine", "location": "sandbox"},
        environment=environment,
        secrets=DeploymentSecretsSpec(**secrets) if secrets else None,
    )
    await row.save()
    return row


__all__ = ["make_deployment"]

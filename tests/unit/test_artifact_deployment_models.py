from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.worldview.models import DeploymentObservation, DeploymentTarget


def test_artifact_reads_legacy_shape_but_emits_new_contract(tmp_path):
    artifact = Artifact(
        name="Web",
        artifact_type="WEBAPP",
        path=str(tmp_path / "web"),
        port="8080",
    )
    payload = artifact.model_dump(mode="json")
    assert artifact.kind == "application.web"
    assert artifact.origin.kind == "local"
    assert all(key not in payload for key in ("artifact_type", "path", "port", "metadata"))
    assert uuid.UUID(artifact.id).version == 4


def test_deployment_normalizes_kind_and_requires_valid_artifact_reference():
    deployment = Deployment(
        name="Service",
        kind=" GCP.RUN.SERVICE ",
        target=DeploymentTarget(provider="gcp", scope="organizations/1"),
        labels=["inventory"],
        provider_labels={"team": 7},
    )
    assert deployment.kind == "gcp.run.service"
    assert deployment.provider_labels == {"team": "7"}
    deployment.add_label("cloud")
    assert deployment.get_labels() == ["inventory", "cloud"]
    assert deployment.provider_labels == {"team": "7"}
    with pytest.raises(ValueError, match="artifact_id"):
        Deployment(
            name="bad",
            kind="gcp.run.service",
            artifact_id="not-an-id",
            target={"provider": "gcp", "scope": "organizations/1"},
        )


def test_deployment_observations_distinguish_real_zero_from_missing_data():
    deployment = Deployment(
        name="Service",
        kind="gcp.run.service",
        target={"provider": "gcp", "scope": "projects/demo"},
        observations={
            "cost": DeploymentObservation(
                metric="cost.net",
                value=0,
                unit="USD",
                observed_at="2026-07-19T00:00:00Z",
                window_start="2026-06-19T00:00:00Z",
                window_end="2026-07-19T00:00:00Z",
                source="gcp.billing.detailed_export",
            ),
            "activity": DeploymentObservation(
                metric="activity.requests",
                coverage="unavailable",
                observed_at="2026-07-19T00:00:00Z",
                window_start="2026-07-18T00:00:00Z",
                window_end="2026-07-19T00:00:00Z",
                source="gcp.monitoring",
            ),
        },
    )

    assert deployment.observations["cost"].value == 0
    assert deployment.observations["activity"].value is None
    with pytest.raises(ValueError, match="must not carry a value"):
        DeploymentObservation(
            metric="activity.requests",
            coverage="unavailable",
            value=0,
            observed_at="2026-07-19T00:00:00Z",
            source="gcp.monitoring",
        )
    with pytest.raises(ValueError, match="finite"):
        DeploymentObservation(
            metric="cost.net",
            value=float("nan"),
            unit="USD",
            observed_at="2026-07-19T00:00:00Z",
            source="gcp.billing.detailed_export",
        )


def test_deployment_observation_contract_rejects_coercion_and_incomparable_windows():
    with pytest.raises(ValueError, match="number"):
        DeploymentObservation(
            metric="cost.net",
            value="12.5",
            unit="USD",
            observed_at="2026-07-19T00:00:00Z",
            source="gcp.billing.detailed_export",
        )
    with pytest.raises(ValueError, match="RFC3339"):
        DeploymentObservation(
            metric="size.provisioned_bytes",
            value=10,
            unit="bytes",
            observed_at="2026-07-19 00:00:00",
            source="gcp.asset_inventory",
        )
    with pytest.raises(ValueError, match="RFC3339"):
        DeploymentObservation(
            metric="size.provisioned_bytes",
            value=10,
            unit="bytes",
            observed_at="2026-02-30T00:00:00Z",
            source="gcp.asset_inventory",
        )
    with pytest.raises(ValueError, match="declared window"):
        Deployment(
            name="No cost window",
            kind="gcp.run.service",
            target={"provider": "gcp", "scope": "projects/demo"},
            observations={
                "cost": {
                    "metric": "cost.net",
                    "value": 12.5,
                    "unit": "USD",
                    "observed_at": "2026-07-19T00:00:00Z",
                    "source": "gcp.billing.detailed_export",
                }
            },
        )
    with pytest.raises(ValueError, match="cost|size|activity"):
        Deployment(
            name="Unknown observation",
            kind="gcp.run.service",
            target={"provider": "gcp", "scope": "projects/demo"},
            observations={
                "latency": {
                    "metric": "activity.latency",
                    "value": 10,
                    "unit": "ms",
                    "observed_at": "2026-07-19T00:00:00Z",
                    "source": "gcp.monitoring",
                }
            },
        )

from __future__ import annotations

import pytest

from flow_sdk.worldview.ontology import kind_ancestors, kind_matches, normalize_kind
from flow_sdk.worldview.providers.gcp import gcp_kind_from_asset_type


def test_kind_ontology_normalizes_matches_and_lists_ancestors():
    assert normalize_kind("  Workload.Service.HTTP  ") == "workload.service.http"
    assert kind_matches("workload.service", "WORKLOAD.SERVICE.HTTP")
    assert not kind_matches("workload.service", "workload.services")
    assert kind_ancestors("resource.database.postgresql") == ["resource", "resource.database"]


@pytest.mark.parametrize("kind", ["", ".web", "web.", "web..app", "Web App", "gcp/run"])
def test_kind_ontology_rejects_invalid_grammar(kind: str):
    with pytest.raises(ValueError):
        normalize_kind(kind)


def test_gcp_asset_type_maps_mechanically_to_kind():
    assert gcp_kind_from_asset_type("run.googleapis.com/Service") == "gcp.run.service"
    assert gcp_kind_from_asset_type("compute.googleapis.com/BackendService") == "gcp.compute.backend_service"

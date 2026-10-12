"""Dependency writes cannot produce a manifest its next read rejects."""

import pytest
from pydantic import ValidationError

from flow_sdk.assets import flow_json
from flow_sdk.schema.data_spec.flow_json_spec import AssetFlowJsonSpec, FlowDependency, FlowJsonSpec

SOURCE = "data_source-2aac20c0-c604-4560-9a47-57f04f7e392a"


@pytest.mark.parametrize("spec", [AssetFlowJsonSpec, FlowJsonSpec])
@pytest.mark.parametrize("name", ["WAHA stress catalog", "", "bad/name", "name\n", "a" * 65])
def test_invalid_dependency_name_cannot_corrupt_existing_manifest(tmp_path, spec, name):
    flow_json.write_dependency(tmp_path, FlowDependency(name="existing", source=SOURCE), spec)
    before = (tmp_path / "flow.json").read_bytes()
    with pytest.raises(ValidationError, match="not a dependency name"):
        flow_json.write_dependency(tmp_path, FlowDependency(name=name, source=SOURCE), spec)
    assert (tmp_path / "flow.json").read_bytes() == before
    assert flow_json.read_strict(tmp_path, spec).find("existing") is not None


@pytest.mark.parametrize("spec", [AssetFlowJsonSpec, FlowJsonSpec])
def test_dependency_handle_and_human_label_round_trip(tmp_path, spec):
    dep = FlowDependency(name="stress-catalog", source=SOURCE, label="WAHA stress catalog")
    flow_json.write_dependency(tmp_path, dep, spec)
    assert flow_json.read_strict(tmp_path, spec).find(dep.name) == dep

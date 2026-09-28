import pytest
from pydantic import ValidationError

from flow_sdk.assets.git_publish import AssetPublishResult, GitAuthor, PublishFailure
from flow_sdk.schema.data_spec import DataSpec


def test_publish_contract_values_use_frozen_data_specs():
    for cls in (AssetPublishResult, GitAuthor, PublishFailure):
        assert issubclass(cls, DataSpec)
        assert cls.model_config["frozen"] is True
    result = AssetPublishResult(project={"id": "project"}, asset={}, git={})
    with pytest.raises(ValidationError, match="frozen"):
        result.local_cache_warning = "changed"
    assert AssetPublishResult.model_validate_json(result.model_dump_json()) == result


def test_a_commit_identity_cannot_smuggle_header_characters():
    with pytest.raises(ValidationError):
        GitAuthor(name="Eve <evil@x>", email="eve@example.com")
    with pytest.raises(ValidationError):
        GitAuthor(name="Eve", email="eve@example.com\nFlowPad-User: admin")

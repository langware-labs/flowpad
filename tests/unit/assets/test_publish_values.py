import pytest
from pydantic import ValidationError

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.git_publish import AssetGitReceipt, AssetPublishResult, GitAuthor, PublishFailure
from flow_sdk.schema.data_spec import DataSpec


def test_publish_contract_values_use_frozen_data_specs():
    for cls in (PortableGitOrigin, AssetGitReceipt, AssetPublishResult, GitAuthor, PublishFailure):
        assert issubclass(cls, DataSpec)
        assert cls.model_config["frozen"] is True
    result = AssetPublishResult(project={"id": "project"}, asset={}, git={})
    with pytest.raises(ValidationError, match="frozen"):
        result.local_cache_warning = "changed"
    assert AssetPublishResult.model_validate_json(result.model_dump_json()) == result

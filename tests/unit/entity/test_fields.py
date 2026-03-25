import pytest

from tests.unit.entity.test_models import TEntity

# TODO fix execution context


async def test_entity_json():
    entity0 = TEntity(id="1", test_data="42")
    ejson = entity0.model_dump()
    assert ejson.get("id", None) == "1"
    assert ejson.get("test_data", None) == "42"
    assert ejson.get("none_api_field", None) is None


if __name__ == "__main__":
    pytest.main()

"""`"?[kind]"` is an optional list; `[kind]` stays a required one."""
import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.spec import DataSpec, _normalize_form


def test_optional_list_may_be_absent_or_a_list():
    T = DataSpec.parse({"name": "string", "tags": "?[string]"})
    assert T(name="a").tags is None
    assert T(name="a", tags=["x", "y"]).tags == ["x", "y"]
    with pytest.raises(ValidationError):
        T(name="a", tags=[1, {"no": "list of strings"}])


def test_a_json_list_stays_required():
    T = DataSpec.parse({"tags": ["string"]})
    with pytest.raises(ValidationError):
        T()


def test_the_element_is_normalized_like_any_kind():
    assert _normalize_form("?[string]") == "?[string]"
    with pytest.raises(ValueError):
        _normalize_form("?[Not A Kind!]")


def test_apply_reads_the_kind_inside_an_optional_list():
    from flow_sdk.schema.data_spec.declared import _qualify, kinds_named

    assert kinds_named("?[crm.note]") == ["crm.note"]
    assert kinds_named("?[string]") == []
    assert _qualify("?[crm.note]", "") == "?[crm.note]"

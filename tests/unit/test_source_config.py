"""A driver's typed ``Config``: the create rule, the draft, the best match, and the loader's agreement check."""
from __future__ import annotations

from typing import Annotated, Optional

import pytest
from pydantic import Field, SecretStr, StringConstraints, ValidationError

from flow_sdk.ingest.driver_registry import DriverLoadError, check_config
from flow_sdk.schema.data_spec.data_driver_spec import DataDriverSpec
from flow_sdk.sources.base import Source
from flow_sdk.sources.config import SourceConfig

Url = Annotated[str, StringConstraints(pattern=r"^https?://")]


class _Config(SourceConfig):
    urls: list[Url] = Field(min_length=1)
    min_score: int = 10
    label: Optional[str] = None


class _Source(Source):
    provider = "config-test"
    Config = _Config


def _manifest(fields, **auth) -> DataDriverSpec:
    return DataDriverSpec(name="config-test", schema=1, config={k: {"label": k} for k in fields}, **({"auth": auth} if auth else {}))


def test_a_create_is_validated_whole_and_typed_strings_are_shaped():
    config = _Config.model_validate({"urls": "http://a\nhttp://b", "min_score": "5"})
    assert (config.urls, config.min_score) == (["http://a", "http://b"], 5)
    with pytest.raises(ValidationError):
        _Config.model_validate({"urls": "ftp://x"})
    with pytest.raises(ValidationError):
        _Config.model_validate({})


def test_a_draft_keeps_only_known_valid_keys():
    assert _Config.draft({"urls": "ftp://x", "min_score": "7", "junk": 1}) == {"min_score": 7}


def test_a_stored_config_takes_the_best_match_and_defaults_the_rest():
    assert _Config.best_match({"urls": ["http://a"], "min_score": "nope", "gone": True}) == {
        "urls": ["http://a"], "min_score": 10, "label": None,
    }


def test_the_loader_accepts_a_catalog_that_names_the_config_fields():
    check_config(_Source, _manifest(["urls", "min_score", "label"]))


@pytest.mark.parametrize("fields,words", [
    (["urls", "min_score"], "no form hints for ['label']"),
    (["urls", "min_score", "label", "extra"], "does not have: ['extra']"),
])
def test_the_loader_refuses_a_catalog_that_disagrees(fields, words):
    with pytest.raises(DriverLoadError, match=words.replace("[", r"\[").replace("]", r"\]")):
        check_config(_Source, _manifest(fields))


def test_derived_fields_need_no_form_hint():
    class Derived(_Config):
        derived = ("label",)

    class DerivedSource(_Source):
        Config = Derived

    check_config(DerivedSource, _manifest(["urls", "min_score"]))


def test_a_secret_in_a_config_is_refused_by_type_and_by_auth_name():
    class Typed(SourceConfig):
        token: SecretStr

    class TypedSource(_Source):
        Config = Typed

    with pytest.raises(DriverLoadError, match="never config"):
        check_config(TypedSource, _manifest(["token"]))

    class Named(SourceConfig):
        api_key: str = ""

    class NamedSource(_Source):
        Config = Named

    with pytest.raises(DriverLoadError, match="never config"):
        check_config(NamedSource, _manifest(["api_key"], secrets={"api_key": ""}))


def test_a_driver_creates_its_config_and_a_source_from_it():
    from flow_sdk.builtin.data_driver import DataDriver

    driver = DataDriver.for_class(_Source)
    config = driver.create_config(urls=["http://a"], min_score="3")
    assert isinstance(config, _Config) and config.min_score == 3

    source = driver.create_source(config, name="probe")
    assert (source.provider, source.config) == ("config-test", {"urls": ["http://a"], "min_score": 3})
    with pytest.raises(ValueError, match=r"config.urls is not valid: ftp://x"):
        driver.create_config(urls=["ftp://x"])

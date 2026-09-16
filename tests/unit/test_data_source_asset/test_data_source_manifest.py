"""The manifest's validation rules — ``ManifestSpec`` validators plus its
folder-side ``runtime_for_folder`` — exercised as pure functions.

Every rule here is a load ERROR rather than a warning, and each one exists
because the silent version of it produced a real bug: a second owner for a fact
the source class already declares, a picker offering a mode that cannot work, or
a folder whose implementation nobody can run.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.data_source_manifest_spec import ManifestError, ManifestSpec, Runtime

RSS = {"schema": 1, "name": "rss", "title": "RSS / Atom",
       "config": {"feed_urls": {"type": "lines", "required": True, "label": "Feed URLs"}}}


def parse(data: dict, files: set[str] = frozenset({"data_source.json", "source.py"})) -> tuple[ManifestSpec, Runtime]:
    spec = ManifestSpec.model_validate(data)
    return spec, spec.runtime_for_folder(set(files))


def test_the_simplest_source_parses():
    m, runtime = parse(RSS)
    assert (m.name, runtime, m.reflect) == ("rss", Runtime.SOURCE, ["record"])
    assert m.config["feed_urls"].required is True
    assert m.manifest_schema == 1, "the file says `schema`, the row says `manifest_schema`"


def test_a_source_names_its_record_kind():
    assert parse({**RSS, "kind": "datasource.feed.rss"})[0].kind == "datasource.feed.rss"
    assert parse(RSS)[0].kind == "", "omitted: the registry defaults it to datasource.<name>"


@pytest.mark.parametrize("retired", ["fetch.py", "FETCH.md"])
def test_a_retired_runtime_is_refused_with_the_upgrade(retired):
    """A folder carrying the retired authored runtimes indexed as a definition nothing could run;
    the author is told what to write instead."""
    with pytest.raises(ManifestError, match="upgrade: write source.py"):
        parse(RSS, files={retired})


def test_traits_are_the_source_classes_not_the_manifests():
    """A source's traits are ClassVars on its class; a manifest copy is a second owner that drifts."""
    with pytest.raises(ValidationError, match="traits"):
        parse({**RSS, "traits": {"channel": "rss"}})


def test_a_choosable_field_must_have_a_picker_shape():
    """`choices` says the PROVIDER supplies the values; `type` says how they are drawn.

    Pairing them is the whole reason `choices` is a flag and not a `FieldType`: `text`
    picks one and `lines` picks many, so a `number` that declares `choices` would reach
    the form as a picker with no widget — the same shape of bug as offering a reflect
    mode that cannot work.
    """
    lines = {**RSS, "config": {"channels": {"type": "lines", "choices": True}}}
    assert parse(lines)[0].config["channels"].choices is True
    one = {**RSS, "config": {"bucket": {"type": "text", "choices": True}}}
    assert parse(one)[0].config["bucket"].choices is True
    with pytest.raises(ValidationError, match="no picker shape"):
        parse({**RSS, "config": {"min_score": {"type": "number", "choices": True}}})


def test_a_field_is_not_choosable_by_default():
    """Nine of the twelve providers ask for an address the user already knows."""
    assert parse(RSS)[0].config["feed_urls"].choices is False


def test_reflect_cannot_offer_record_beside_filesystem_modes():
    with pytest.raises(ValidationError, match="alongside filesystem modes"):
        parse({**RSS, "reflect": ["record", "copy"]})


def test_auth_is_exactly_one_shape():
    with pytest.raises(ValidationError, match="one credential lifetime"):
        parse({**RSS, "auth": {"connector": "slack", "env": ["T"]}}, files=set())
    with pytest.raises(ValidationError, match="one credential lifetime"):
        parse({**RSS, "auth": {"env": ["T"], "secrets": {"api_key": ""}}}, files=set())
    with pytest.raises(ValidationError, match="must declare one of"):
        parse({**RSS, "auth": {"scopes": ["a"]}}, files=set())
    assert parse({**RSS, "auth": {"connector": "slack", "scopes": ["a"]}}, files=set())[0].auth.scopes == ["a"]
    assert parse({**RSS, "auth": {"secrets": {"api_key": "ingest_api.x"}}}, files=set())[0].auth.secrets == {"api_key": "ingest_api.x"}


def test_unknown_keys_are_refused_not_ignored():
    """A typo that is dropped silently is a field the author thinks is applied."""
    with pytest.raises(ValidationError, match="labl"):
        parse({**RSS, "config": {"x": {"labl": "typo"}}}, files=set())
    with pytest.raises(ValidationError):
        parse({**RSS, "colour": "blue"}, files=set())


def test_schema_version_is_required_and_checked():
    with pytest.raises(ValidationError, match="unsupported schema"):
        parse({"name": "x"}, files=set())


def test_title_defaults_to_name():
    assert parse({"schema": 1, "name": "hn"})[0].title == "hn"


@pytest.mark.parametrize("build", [
    lambda: ManifestSpec.model_validate(RSS).config["feed_urls"],
    lambda: ManifestSpec.model_validate({**RSS, "auth": {"env": ["TOKEN"]}}).auth,
], ids=["ConfigFieldSpec", "AuthSpec"])
def test_the_value_specs_are_frozen(build):
    """A value is a value (CLAUDE.md): a field and an auth shape travel between the manifest, the
    row and the form, and neither is edited in place — `model_copy(update=...)` is the way to a
    changed one."""
    value = build()
    field = next(iter(type(value).model_fields))
    with pytest.raises(ValidationError):
        setattr(value, field, getattr(value, field))
    assert value.model_copy(update={field: getattr(value, field)}) == value

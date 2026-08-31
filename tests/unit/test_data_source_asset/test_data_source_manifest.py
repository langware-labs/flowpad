"""The manifest's validation rules — ``ManifestSpec`` validators plus its
folder-side ``runtime_for_folder`` — exercised as pure functions.

Every rule here is a load ERROR rather than a warning, and each one exists
because the silent version of it produced a real bug: a second owner for a fact
the driver already declares, a picker offering a mode that cannot work, or a
folder whose implementation nobody meant to ship.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.data_source_spec import ManifestError, ManifestSpec, Runtime

RSS = {"schema": 1, "name": "rss", "title": "RSS / Atom",
       "config": {"feed_urls": {"type": "lines", "required": True, "label": "Feed URLs"}}}


def parse(data: dict, files: set[str] = frozenset({"data_source.json"})) -> tuple[ManifestSpec, Runtime]:
    spec = ManifestSpec.model_validate(data)
    return spec, spec.runtime_for_folder(set(files))


def test_the_simplest_source_parses():
    m, runtime = parse(RSS)
    assert (m.name, runtime, m.reflect) == ("rss", Runtime.BUILTIN, ["record"])
    assert m.config["feed_urls"].required is True
    assert m.manifest_schema == 1, "the file says `schema`, the row says `manifest_schema`"


def test_runtime_comes_from_the_folder_not_a_field():
    assert parse(RSS, files={"data_source.json"})[1] is Runtime.BUILTIN
    assert parse({**RSS, "name": "wiki"}, files={"fetch.py"})[1] is Runtime.SCRIPT
    with pytest.raises(ManifestError, match="keep one"):
        parse(RSS, files={"fetch.py", "FETCH.md"})


def test_a_builtin_may_not_declare_traits():
    """Its driver class owns them, and a second copy drifts."""
    with pytest.raises(ManifestError, match="driver class owns them"):
        parse({**RSS, "traits": {"channel": "rss"}})


def test_a_script_source_may_declare_traits():
    m, runtime = parse({**RSS, "name": "wiki", "traits": {"emits": "content.page", "owns_bytes": False}}, files={"fetch.py"})
    assert runtime is Runtime.SCRIPT
    assert m.traits.emits == "content.page"
    assert m.traits.owns_bytes is False


def test_a_trait_nothing_implements_is_refused():
    """`id_unique_within` promised an irreversible-merge guarantee that the
    natural key — always (data_source_id, segment_key, external_id) — never provided.
    Declaring it is a load error rather than a field that changes nothing."""
    with pytest.raises(ValidationError, match="id_unique_within"):
        parse({**RSS, "name": "wiki", "traits": {"emits": "x", "id_unique_within": "source"}}, files={"fetch.py"})


def test_the_agent_runtime_is_refused_until_it_exists():
    """A FETCH.md folder used to index as a valid spec and then fail every poll
    with `unknown_provider`, because only the script runtime is dispatched."""
    with pytest.raises(ManifestError, match="reserved but not implemented"):
        parse({**RSS, "name": "wiki"}, files={"FETCH.md"})


def test_reflect_cannot_offer_record_beside_filesystem_modes():
    with pytest.raises(ValidationError, match="alongside filesystem modes"):
        parse({**RSS, "reflect": ["record", "copy"]})


def test_auth_is_one_shape_or_the_other():
    with pytest.raises(ValidationError, match="one credential lifetime"):
        parse({**RSS, "auth": {"connector": "slack", "env": ["T"]}}, files=set())
    assert parse({**RSS, "auth": {"connector": "slack", "scopes": ["a"]}}, files=set())[0].auth.scopes == ["a"]


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

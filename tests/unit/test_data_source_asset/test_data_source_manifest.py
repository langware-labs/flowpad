"""The manifest's validation rules, exercised as pure functions.

Every rule here is a load ERROR rather than a warning, and each one exists
because the silent version of it produced a real bug: a second owner for a fact
the driver already declares, a picker offering a mode that cannot work, or a
folder whose implementation nobody meant to ship.
"""
from __future__ import annotations

import pytest

from flow_sdk.ingest.manifest import (
    ManifestError,
    Runtime,
    parse_manifest,
    runtime_for,
)

RSS = {"schema": 1, "name": "rss", "title": "RSS / Atom",
       "config": {"feed_urls": {"type": "lines", "required": True, "label": "Feed URLs"}}}


def test_the_simplest_source_parses():
    m = parse_manifest(RSS, files={"data_source.json"})
    assert (m.name, m.runtime, m.reflect) == ("rss", Runtime.BUILTIN, ("record",))
    assert m.config["feed_urls"].required is True


def test_runtime_comes_from_the_folder_not_a_field():
    assert runtime_for({"data_source.json"}) is Runtime.BUILTIN
    assert runtime_for({"fetch.py"}) is Runtime.SCRIPT
    assert runtime_for({"FETCH.md"}) is Runtime.AGENT
    with pytest.raises(ManifestError, match="keep one"):
        runtime_for({"fetch.py", "FETCH.md"})


def test_a_builtin_may_not_declare_traits():
    """Its driver class owns them, and a second copy drifts."""
    with pytest.raises(ManifestError, match="driver class owns them"):
        parse_manifest({**RSS, "traits": {"channel": "rss"}}, files={"data_source.json"})


def test_a_script_source_may_declare_traits():
    m = parse_manifest(
        {**RSS, "name": "wiki", "traits": {"emits": "content.page", "owns_bytes": False}},
        files={"fetch.py"},
    )
    assert m.runtime is Runtime.SCRIPT
    assert m.traits.emits == "content.page"
    assert m.traits.owns_bytes is False


def test_a_trait_nothing_implements_is_refused():
    """`id_unique_within` promised an irreversible-merge guarantee that the
    natural key — always (source_id, segment_key, external_id) — never provided.
    Declaring it is a load error rather than a field that changes nothing."""
    with pytest.raises(ManifestError, match="unknown keys"):
        parse_manifest(
            {**RSS, "name": "wiki", "traits": {"emits": "x", "id_unique_within": "source"}},
            files={"fetch.py"},
        )


def test_the_agent_runtime_is_refused_until_it_exists():
    """A FETCH.md folder used to index as a valid spec and then fail every poll
    with `unknown_provider`, because only the script runtime is dispatched."""
    with pytest.raises(ManifestError, match="reserved but not implemented"):
        parse_manifest({**RSS, "name": "wiki"}, files={"FETCH.md"})


def test_reflect_cannot_offer_record_beside_filesystem_modes():
    with pytest.raises(ManifestError, match="alongside filesystem modes"):
        parse_manifest({**RSS, "reflect": ["record", "copy"]}, files={"data_source.json"})


def test_auth_is_one_shape_or_the_other():
    with pytest.raises(ManifestError, match="one credential lifetime"):
        parse_manifest({**RSS, "auth": {"connector": "slack", "env": ["T"]}}, files=set())
    assert parse_manifest({**RSS, "auth": {"connector": "slack", "scopes": ["a"]}},
                          files=set()).auth.scopes == ("a",)


def test_unknown_keys_are_refused_not_ignored():
    """A typo that is dropped silently is a field the author thinks is applied."""
    with pytest.raises(ManifestError, match="unknown keys"):
        parse_manifest({**RSS, "config": {"x": {"labl": "typo"}}}, files=set())


def test_schema_version_is_required_and_checked():
    with pytest.raises(ManifestError, match="unsupported schema"):
        parse_manifest({"name": "x"}, files=set())

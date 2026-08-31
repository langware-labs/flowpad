"""``tags.envelope.parse_target`` — the one inverse of ``target_of``.

Five call sites used to hand-roll this (hub_bridge, resource_tracker,
service_urls, flow_message, conversation) with three different rules; two of
them split on the FIRST hyphen, which silently mangles a hyphenated type name
like ``compute-node``.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.tags.envelope import parse_target, target_of

UUID = "9b726861-1839-4d35-8e6e-cdd8556fe314"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # TypeId form — the id is the TRAILING uuid, not the first hyphen.
        (f"project-{UUID}", ("project", UUID)),
        (f"compute-node-{UUID}", ("compute-node", UUID)),
        (f"agentic_process-{UUID}", ("agentic_process", UUID)),
        # Normative colon form.
        (f"project:{UUID}", ("project", UUID)),
        ("compute-node:abc", ("compute-node", "abc")),
        # No uuid, no colon → first hyphen.
        ("skill-my-skill", ("skill", "my-skill")),
        # Unparseable.
        ("nope", (None, None)),
        ("", (None, None)),
        (None, (None, None)),
        (17, (None, None)),
    ],
)
def test_parse_target_strings(raw, expected):
    assert parse_target(raw) == expected


def test_parse_target_uuid_is_case_insensitive():
    assert parse_target(f"project-{UUID.upper()}") == ("project", UUID.upper())


def test_parse_target_mapping_and_attrs():
    assert parse_target({"type": "project", "id": UUID}) == ("project", UUID)
    assert parse_target({"nothing": 1}) == (None, None)
    assert parse_target(SimpleNamespace(type="project", id=UUID)) == ("project", UUID)
    assert parse_target(SimpleNamespace(type="project")) == (None, None)


def test_parse_target_inverts_target_of():
    assert parse_target(target_of("compute-node", UUID)) == ("compute-node", UUID)
    assert parse_target(target_of("project", UUID)) == ("project", UUID)

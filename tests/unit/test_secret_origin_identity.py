"""A secret's identity is (project_id, ENV_VAR_NAME) and nothing else.

The property that matters: identity survives the value MOVING between stores.
Under the previous scheme the id was derived from the locator, so promoting a
key from .env.local into the encrypted sodot minted a different entity and
orphaned every link to it.
"""

import uuid

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.secret_origin_identity import secret_origin_id, stable_key

PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
OTHER_PROJECT = "8a1b6d5c-2e34-4f7a-9b1c-77c0de6f9a12"


def test_id_is_deterministic():
    assert secret_origin_id(PROJECT, "OPENAI_API_KEY") == secret_origin_id(PROJECT, "OPENAI_API_KEY")


def test_id_is_a_valid_entity_id():
    """v5 only — the entity-id policy rejects anything else."""
    assert is_valid_entity_id(secret_origin_id(PROJECT, "OPENAI_API_KEY"))


def test_id_is_uuid5_of_the_stable_key():
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, stable_key(PROJECT, "OPENAI_API_KEY")))

    assert secret_origin_id(PROJECT, "OPENAI_API_KEY") == expected


def test_stable_key_shape():
    assert stable_key(PROJECT, "OPENAI_API_KEY") == f"secret-origin:{PROJECT}:OPENAI_API_KEY"


def test_different_env_var_is_a_different_secret():
    assert secret_origin_id(PROJECT, "A_KEY") != secret_origin_id(PROJECT, "B_KEY")


def test_same_env_var_in_another_project_is_a_different_secret():
    assert secret_origin_id(PROJECT, "OPENAI_API_KEY") != secret_origin_id(OTHER_PROJECT, "OPENAI_API_KEY")


def test_env_var_is_case_sensitive():
    """POSIX environments are case-sensitive, so these really are two variables.
    Folding them here would make the id lie about what gets injected."""
    assert secret_origin_id(PROJECT, "API_KEY") != secret_origin_id(PROJECT, "api_key")


def test_surrounding_whitespace_is_stripped():
    assert secret_origin_id(PROJECT, "  OPENAI_API_KEY  ") == secret_origin_id(PROJECT, "OPENAI_API_KEY")
    assert secret_origin_id(f"  {PROJECT} ", "K") == secret_origin_id(PROJECT, "K")


@pytest.mark.parametrize(
    "locator",
    [
        {"kind": "env-local", "env_key": "OPENAI_API_KEY"},
        {"kind": "local", "sod_name": "openai"},
        {"kind": "gcp", "gcp_project": "p", "secret": "s", "version": "latest"},
        {"kind": "flowpad-hub", "secret_id": "sec_1"},
    ],
)
def test_identity_is_independent_of_where_the_value_lives(locator):
    """The whole point. Whatever the declaration currently points at, the
    secret is the same secret."""
    assert secret_origin_id(PROJECT, "OPENAI_API_KEY") == secret_origin_id(PROJECT, "OPENAI_API_KEY")

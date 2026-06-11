"""git identity helpers + GitRemote deterministic get-or-create.

Key/mint tests are pure; the ensure() tests use the session test DB.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.git_remote import GitRemote
from flow_sdk.utils.git_identity import (
    canonical_git_remote_key,
    mint_git_remote_id,
    parse_git_remote_url,
)


# ── canonical key + mint ──────────────────────────────────────────────────────


def test_key_case_folds_and_strips():
    assert canonical_git_remote_key(" GitHub ", "Foo", "Bar.git") == "git:github:foo/bar"
    assert canonical_git_remote_key("github", "foo", "bar") == "git:github:foo/bar"


def test_mint_is_deterministic_and_policy_valid():
    a = mint_git_remote_id("github", "foo", "bar")
    b = mint_git_remote_id(" GitHub ", "Foo", "Bar.git")
    assert a == b
    assert is_valid_entity_id(a)
    assert uuid.UUID(a).version == 5


def test_distinct_repos_distinct_ids():
    assert mint_git_remote_id("github", "foo", "bar") != mint_git_remote_id("github", "foo", "baz")
    assert mint_git_remote_id("github", "foo", "bar") != mint_git_remote_id("gitlab", "foo", "bar")


# ── URL parser ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/Org/Repo.git",
        "https://github.com/Org/Repo",
        "git@github.com:Org/Repo.git",
        "ssh://git@github.com/Org/Repo.git",
        "https://github.com/Org/Repo/",
    ],
)
def test_parse_known_provider_forms(url):
    assert parse_git_remote_url(url) == ("github", "Org", "Repo")


def test_parse_unknown_host_uses_hostname_as_provider():
    assert parse_git_remote_url("https://git.corp.io/team/proj.git") == ("git.corp.io", "team", "proj")


@pytest.mark.parametrize("url", ["", "   ", "not-a-url", "https://github.com/"])
def test_parse_rejects_unusable(url):
    assert parse_git_remote_url(url) is None


# ── ensure(): deterministic get-or-create ─────────────────────────────────────


@pytest.mark.asyncio
async def test_ensure_idempotent_and_untouched():
    first = await GitRemote.ensure("github", "EnsureOrg", "EnsureRepo")
    second = await GitRemote.ensure("GitHub", "ensureorg", "ensurerepo.git")
    assert first.id == second.id == mint_git_remote_id("github", "EnsureOrg", "EnsureRepo")
    # The existing row is returned untouched — display case from first mint wins.
    assert second.owner == "EnsureOrg"
    rows = await GitRemote.get_all({"id": first.id})
    assert len(rows) == 1
    assert rows[0].full_name == "EnsureOrg/EnsureRepo"

"""GitOrigin identity helper tests."""

from __future__ import annotations

import pytest

from flow_sdk.utils.git_identity import canonical_git_origin_repo_key, parse_git_origin_url


def test_key_case_folds_and_strips():
    assert canonical_git_origin_repo_key(" GitHub ", "Foo", "Bar.git") == "git:github:foo/bar"
    assert canonical_git_origin_repo_key("github", "foo", "bar") == "git:github:foo/bar"


def test_distinct_repos_distinct_keys():
    assert canonical_git_origin_repo_key("github", "foo", "bar") != canonical_git_origin_repo_key(
        "github", "foo", "baz"
    )
    assert canonical_git_origin_repo_key("github", "foo", "bar") != canonical_git_origin_repo_key(
        "gitlab", "foo", "bar"
    )


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
    assert parse_git_origin_url(url) == ("github", "Org", "Repo")


def test_parse_unknown_host_uses_hostname_as_provider():
    assert parse_git_origin_url("https://git.corp.io/team/proj.git") == ("git.corp.io", "team", "proj")


@pytest.mark.parametrize("url", ["", "   ", "not-a-url", "https://github.com/"])
def test_parse_rejects_unusable(url):
    assert parse_git_origin_url(url) is None

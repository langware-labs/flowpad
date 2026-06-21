"""Unit tests for GitRepo._classify_push_error — typed publish failure kinds.

Pure string classification; lets the publish UI give state-specific, plain-language
guidance (permission / no-remote / network / conflict) instead of one generic
"Push failed". No git, no IO.
"""

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo

classify = GitRepo._classify_push_error


@pytest.mark.parametrize(
    "stderr,expected",
    [
        ("remote: Permission to acme/repo.git denied to bob.", "permission"),
        ("ERROR: Permission denied (publickey).", "permission"),
        ("fatal: Authentication failed for 'https://github.com/acme/repo.git/'", "permission"),
        ("The requested URL returned error: 403", "permission"),
        ("git@github.com: Could not read from remote repository.", "permission"),
        ("fatal: 'origin' does not appear to be a git repository", "no_remote"),
        ("fatal: No configured push destination.", "no_remote"),
        ("fatal: The current branch main has no upstream branch.", "no_remote"),
        ("ssh: Could not resolve hostname github.com: nodename nor servname provided", "network"),
        ("fatal: unable to access ...: Failed to connect to github.com port 443: Connection refused", "network"),
        ("! [rejected]        main -> main (non-fast-forward)", "conflict"),
        ("Updates were rejected because the remote contains work that you do not have. fetch first", "conflict"),
        ("error: failed to push some refs", "generic"),
        ("", "generic"),
    ],
)
def test_classify_push_error(stderr, expected):
    assert classify(stderr) == expected

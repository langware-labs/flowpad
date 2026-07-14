"""Source-policy guards for cycle-isolated live-hub tests."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# (file, assignment, cycle env key, fallback mapping, fallback key)
ACTOR_CREDENTIAL_ASSIGNMENTS = [
    ("test_conversation_list_pipeline.py", "sender_email", "BOB_EMAIL", "app_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_conversation_list_pipeline.py", "sender_pw", "BOB_PW", "app_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
    ("test_conversation_worldview.py", "alice_email", "ALICE_EMAIL", "oss_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_conversation_worldview.py", "alice_pw", "ALICE_PW", "oss_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
    ("test_conversation_worldview.py", "bob_email", "BOB_EMAIL", "app_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_conversation_worldview.py", "bob_pw", "BOB_PW", "app_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
    ("test_members_basic_operations.py", "bob_email", "BOB_EMAIL", "app_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_members_basic_operations.py", "bob_pw", "BOB_PW", "app_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
    ("test_share_into_existing_conversation.py", "bob_email", "BOB_EMAIL", "app_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_share_into_existing_conversation.py", "bob_pw", "BOB_PW", "app_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
    ("test_share_with_recipients.py", "bob_email", "BOB_EMAIL", "app_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_share_with_recipients.py", "bob_pw", "BOB_PW", "app_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
    ("test_two_client_loop.py", "alice_email", "ALICE_EMAIL", "oss_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_two_client_loop.py", "alice_pw", "ALICE_PW", "oss_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
    ("test_two_client_loop.py", "bob_email", "BOB_EMAIL", "app_env", "FLOWPAD_CLOUD_USER_EMAIL"),
    ("test_two_client_loop.py", "bob_pw", "BOB_PW", "app_env", "FLOWPAD_CLOUD_USER_PASSWORD"),
]


def _dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else None
    return None


def _is_get_call(node: ast.AST, owner: str, key: str) -> bool:
    return (
        isinstance(node, ast.Call)
        and _dotted_name(node.func) == f"{owner}.get"
        and len(node.args) == 1
        and isinstance(node.args[0], ast.Constant)
        and node.args[0].value == key
    )


def _assignment_value(tree: ast.AST, name: str) -> ast.AST:
    matches = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
        and isinstance(node.value, ast.BoolOp)
    ]
    assert len(matches) == 1, f"expected one credential assignment to {name}, found {len(matches)}"
    return matches[0]


@pytest.mark.parametrize(
    ("filename", "assignment", "env_key", "fallback_owner", "fallback_key"),
    ACTOR_CREDENTIAL_ASSIGNMENTS,
)
def test_live_hub_actor_credentials_prefer_cycle_env(
    filename: str,
    assignment: str,
    env_key: str,
    fallback_owner: str,
    fallback_key: str,
):
    source = (REPO_ROOT / "tests" / "hub_tests" / filename).read_text()
    value = _assignment_value(ast.parse(source), assignment)

    assert isinstance(value, ast.BoolOp) and isinstance(value.op, ast.Or)
    assert len(value.values) == 2
    assert _is_get_call(value.values[0], "os.environ", env_key)
    assert _is_get_call(value.values[1], fallback_owner, fallback_key)


def test_comment_sync_fixture_unlinks_exact_generated_doc_from_finally():
    path = REPO_ROOT / "tests" / "hub_tests" / "test_doc_comment_child_sync.py"
    source = path.read_text()
    assert 'cleanup_path = Path(os.path.expanduser("~/docs")) / f"comment-sync-{stamp}.md"' in source

    tree = ast.parse(source)
    shared = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "shared")
    guarded = next(node for node in shared.body if isinstance(node, ast.Try))
    assert any(
        isinstance(node, ast.Call) and _dotted_name(node.func) == "_build_shared"
        for statement in guarded.body
        for node in ast.walk(statement)
    )

    unlink_calls = [
        node
        for statement in guarded.finalbody
        for node in ast.walk(statement)
        if isinstance(node, ast.Call) and _dotted_name(node.func) == "cleanup_path.unlink"
    ]
    assert len(unlink_calls) == 1
    missing_ok = next((keyword.value for keyword in unlink_calls[0].keywords if keyword.arg == "missing_ok"), None)
    assert isinstance(missing_ok, ast.Constant) and missing_ok.value is True

import json
import sqlite3
from uuid import UUID

from flow_sdk.migrations.migration_2026_10_role_sets import STAMP_TABLE, migrate, migrate_record


def database(tmp_path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    path = tmp_path / "roles.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE entities(id TEXT PRIMARY KEY, type TEXT, data TEXT)")
        conn.execute(
            "CREATE TABLE relationships(id TEXT PRIMARY KEY,type TEXT,from_id TEXT,from_type TEXT,to_id TEXT,to_type TEXT,from_role TEXT,to_role TEXT,is_child BOOL,is_final BOOL,data TEXT)"
        )
    return path


def add_entity(path, id, kind, data):
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO entities VALUES(?,?,?)", (id, kind, json.dumps(data)))


def add_edge(path, id, kind, role, *, source="user"):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO relationships VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (id, "Role", "principal", source, "target", kind, "*", role, 0, 0, "{}"),
        )


def test_dry_run_apply_and_rerun_preserve_independent_roles(tmp_path):
    path = database(tmp_path)
    add_entity(
        path,
        "conversation",
        "conversation",
        {"visitor_role": "anonymous_viewer", "members": [{"user_id": "person", "role": "member"}]},
    )
    add_entity(
        path,
        "project",
        "project",
        {"members": [{"user_id": "person", "role": "member"}], "untouched": {"role": "assistant"}},
    )
    add_edge(path, "conv-edge", "conversation", "member")
    add_edge(path, "budget-edge", "llm_endpoint", "reader")
    add_edge(path, "runtime-edge", "llm_endpoint", "reader", source="compute_node")
    add_edge(path, "parent-edge", "task", "guest")
    before = path.read_bytes()
    preview = migrate(path)
    assert preview["records"] == 2
    assert preview["extra_edges"] == 2
    assert not preview["errors"] and not preview["completed"]
    assert path.read_bytes() == before
    applied = migrate(path, dry_run=False)
    assert applied["completed"]
    with sqlite3.connect(path) as conn:
        conv = json.loads(conn.execute("SELECT data FROM entities WHERE id='conversation'").fetchone()[0])
        project = json.loads(conn.execute("SELECT data FROM entities WHERE id='project'").fetchone()[0])
        assert conv == {"visitor_roles": ["reader"], "members": [{"user_id": "person", "roles": ["reader", "runner"]}]}
        assert project["members"][0]["roles"] == ["reader"]
        assert project["untouched"] == {"role": "assistant"}
        ids = [row[0] for row in conn.execute("SELECT id FROM relationships")]
        original_ids = {"conv-edge", "budget-edge", "runtime-edge", "parent-edge"}
        assert original_ids.issubset(ids)
        assert len(ids) == len(set(ids)) == 6
        assert all(UUID(value).version == 4 for value in set(ids) - original_ids)
        assert conn.execute("SELECT to_role FROM relationships WHERE id='conv-edge'").fetchone() == ("reader",)
        rows = conn.execute("SELECT from_type,to_type,to_role,is_final FROM relationships").fetchall()
        assert {r[2] for r in rows if r[1] == "conversation"} == {"reader", "runner"}
        assert {r[2] for r in rows if r[1] == "llm_endpoint" and r[0] == "user"} == {"reader", "runner"}
        assert {r[2] for r in rows if r[0] == "compute_node"} == {"runner"}
        assert [r[2:] for r in rows if r[1] == "task"] == [("reader", 1)]
    assert migrate(path, dry_run=False) == {
        "dry_run": False,
        "records": 0,
        "edges": 0,
        "extra_edges": 0,
        "errors": [],
        "completed": True,
    }


def test_unknown_role_blocks_all_writes_and_does_not_stamp_completion(tmp_path):
    path = database(tmp_path)
    add_entity(path, "known", "project", {"visitor_role": "reader"})
    add_entity(path, "unknown", "project", {"members": [{"role": "custom-secret"}]})
    add_edge(path, "bad-edge", "project", "invented")
    report = migrate(path, dry_run=False)
    assert len(report["errors"]) == 2
    assert not report["completed"]
    with sqlite3.connect(path) as conn:
        assert "visitor_role" in json.loads(conn.execute("SELECT data FROM entities WHERE id='known'").fetchone()[0])
        assert conn.execute("SELECT name FROM sqlite_master WHERE name=?", (STAMP_TABLE,)).fetchone() is None


def test_cached_invitations_and_login_sets_migrate_without_losing_final_scope():
    source = {
        "organization_role": "member",
        "target_type": "task",
        "target_role": "guest",
        "login_roles": ["owner", "full-access"],
        "invitation_targets": [{"typeid": "task-parent", "role": "guest"}, {"typeid": "task-child", "role": "editor"}],
    }
    result = migrate_record("invitation", source)
    assert result["organization_roles"] == ["reader"]
    assert result["target_roles"] == ["reader"]
    assert result["login_roles"] == ["owner", "admin"]
    assert result["invitation_targets"] == [
        {"typeid": "task-parent", "roles": ["reader"], "is_final": True},
        {"typeid": "task-child", "roles": ["editor"]},
    ]
    assert migrate_record("invitation", result) == result
    assert "organization_role" in source


def test_ambiguous_source_selector_blocks_without_expanding_its_match(tmp_path):
    path = database(tmp_path)
    add_edge(path, "selector", "project", "reader", source="conversation")
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE relationships SET from_role='member'")
    report = migrate(path, dry_run=False)
    assert len(report["errors"]) == 1
    assert "ambiguous source" in report["errors"][0]["error"]
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT from_role,to_role FROM relationships").fetchall() == [("member", "reader")]


def test_holder_is_only_migrated_on_a_budget_and_spender_remains_run_only():
    import pytest

    from flow_sdk.migrations.migration_2026_10_role_sets import legacy_roles

    assert legacy_roles("holder", "llm_endpoint") == ["editor"]
    assert legacy_roles("spender", "llm_endpoint") == ["runner"]
    with pytest.raises(ValueError):
        legacy_roles("holder", "project")


def test_new_role_arrays_remain_independent_and_unknown_arrays_block(tmp_path):
    path = database(tmp_path)
    add_entity(path, "new", "llm_endpoint", {"visitor_roles": ["reader"], "members": [{"roles": ["reader"]}]})
    add_entity(path, "invalid", "project", {"visitor_roles": ["made-up"]})
    report = migrate(path, dry_run=False)
    assert report["records"] == 0
    assert len(report["errors"]) == 1
    assert not report["completed"]


def test_invalid_transfer_retention_blocks_atomic_apply(tmp_path):
    for field, value in (("role_to_keep", "owner"), ("roles_to_keep", ["owner"]), ("roles_to_keep", ["owner_by_api"])):
        path = database(tmp_path / field / str(len(str(value))))
        add_entity(path, "good", "project", {"visitor_role": "guest"})
        add_entity(path, "transfer", "invitation", {field: value})
        before = path.read_bytes()
        assert migrate(path)["errors"]
        assert path.read_bytes() == before
        report = migrate(path, dry_run=False)
        assert report["errors"] and not report["completed"]
        with sqlite3.connect(path) as conn:
            assert "visitor_role" in json.loads(conn.execute("SELECT data FROM entities WHERE id='good'").fetchone()[0])
            assert conn.execute("SELECT name FROM sqlite_master WHERE name=?", (STAMP_TABLE,)).fetchone() is None


def test_legacy_retention_does_not_hide_an_invalid_plural_role():
    import pytest

    with pytest.raises(ValueError, match="roles_to_keep"):
        migrate_record("invitation", {"roles_to_keep": ["owner"], "role_to_keep": "reader"})


def test_enabled_helpdesk_preserves_explicit_staff_but_not_audiences(tmp_path):
    path = database(tmp_path)
    add_entity(
        path,
        "target",
        "project",
        {
            "helpdesk": {"enabled": True},
            "visitor_role": "reader",
            "authenticated_roles": ["reader"],
            "public_role": "guest",
            "members": [{"role": "member"}, {"roles": ["reader"]}, {"roles": ["runner"]}, {"role": "editor"}],
        },
    )
    add_entity(path, "plain", "project", {"helpdesk": {"enabled": False}, "members": [{"role": "member"}]})
    add_entity(path, "public-principal", "group", {"name": "public"})
    add_entity(
        path,
        "early-invitation",
        "invitation",
        {
            "target_type": "project",
            "target_id": "target",
            "target_role": "guest",
            "role_to_keep": "reader",
            "invitation_targets": [{"typeid": "project-target", "roles": ["reader"]}],
        },
    )
    add_entity(
        path, "plain-invitation", "invitation", {"invitation_targets": [{"typeid": "project-plain", "role": "member"}]}
    )
    for edge_id, role in (("staff-reader", "reader"), ("staff-member", "member"), ("staff-runner", "runner")):
        add_edge(path, edge_id, "project", role)
    add_edge(path, "public-edge", "project", "reader", source="group")
    add_edge(path, "plain-edge", "project", "member")
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE relationships SET from_id='public-principal' WHERE id='public-edge'")
        conn.execute("UPDATE relationships SET to_id='plain' WHERE id='plain-edge'")
    before = path.read_bytes()
    preview = migrate(path)
    assert not preview["errors"] and preview["extra_edges"] == 3
    assert path.read_bytes() == before
    assert migrate(path, dry_run=False)["completed"]
    with sqlite3.connect(path) as conn:
        records = {key: json.loads(data) for key, data in conn.execute("SELECT id,data FROM entities")}
        assert records["target"]["members"] == [
            {"roles": ["reader", "runner"]},
            {"roles": ["reader", "runner"]},
            {"roles": ["reader", "runner"]},
            {"roles": ["editor"]},
        ]
        for audience in ("visitor_roles", "authenticated_roles", "public_roles"):
            assert records["target"][audience] == ["reader"]
        assert records["plain"]["members"] == [{"roles": ["reader"]}]
        invitation = records["early-invitation"]
        assert invitation["target_roles"] == invitation["roles_to_keep"] == ["reader", "runner"]
        assert invitation["invitation_targets"] == [{"typeid": "project-target", "roles": ["reader", "runner"]}]
        assert records["plain-invitation"]["invitation_targets"] == [{"typeid": "project-plain", "roles": ["reader"]}]
        assert conn.execute("SELECT to_role FROM relationships WHERE id='public-edge'").fetchone() == ("reader",)
        assert conn.execute("SELECT to_role FROM relationships WHERE id='plain-edge'").fetchone() == ("reader",)
        roles = conn.execute("SELECT to_role FROM relationships WHERE to_id='target' AND from_type='user'").fetchall()
        assert sorted(role[0] for role in roles) == ["reader"] * 3 + ["runner"] * 3
        # A canonical Reader created after the migration remains independent.
        conn.execute(
            "UPDATE entities SET data=? WHERE id='target'",
            (json.dumps({"helpdesk": {"enabled": True}, "members": [{"roles": ["reader"]}]}),),
        )
    add_edge(path, "new-reader", "project", "reader")
    assert migrate(path, dry_run=False)["records"] == 0
    with sqlite3.connect(path) as conn:
        assert json.loads(conn.execute("SELECT data FROM entities WHERE id='target'").fetchone()[0])["members"] == [
            {"roles": ["reader"]}
        ]
        assert conn.execute("SELECT to_role FROM relationships WHERE id='new-reader'").fetchone() == ("reader",)


def test_helpdesk_source_selector_expansion_blocks_atomic_apply(tmp_path):
    path = database(tmp_path)
    add_entity(path, "principal", "project", {"helpdesk": {"enabled": True}, "visitor_role": "guest"})
    add_edge(path, "selector", "conversation", "reader", source="project")
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE relationships SET from_role='reader'")
    report = migrate(path, dry_run=False)
    assert not report["completed"] and "ambiguous source" in report["errors"][0]["error"]
    with sqlite3.connect(path) as conn:
        assert "visitor_role" in json.loads(conn.execute("SELECT data FROM entities").fetchone()[0])
        assert conn.execute("SELECT name FROM sqlite_master WHERE name=?", (STAMP_TABLE,)).fetchone() is None


def test_mixed_helpdesk_retained_targets_require_review():
    import pytest

    with pytest.raises(ValueError, match="ambiguous helpdesk retained"):
        migrate_record(
            "invitation",
            {
                "roles_to_keep": ["reader"],
                "invitation_targets": [
                    {"typeid": "project-desk", "roles": ["owner"]},
                    {"typeid": "project-plain", "roles": ["owner"]},
                ],
            },
            helpdesk_projects=frozenset({"desk"}),
        )


def test_helpdesk_invitation_relationships_and_retention_use_source_project(tmp_path):
    path = database(tmp_path)
    add_entity(path, "principal", "project", {"helpdesk": {"enabled": True}})
    add_entity(path, "target", "invitation", {"role_to_keep": "reader"})
    add_edge(path, "invite", "invitation", "unused", source="project")
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE relationships SET type='invitedthrough',data=?",
            (json.dumps({"invited_to_role": "guest", "provenance": "keep"}),),
        )
    assert migrate(path, dry_run=False)["completed"]
    with sqlite3.connect(path) as conn:
        invitation = json.loads(conn.execute("SELECT data FROM entities WHERE id='target'").fetchone()[0])
        assert invitation["roles_to_keep"] == ["reader", "runner"]
        edges = [(key, json.loads(data)) for key, data in conn.execute("SELECT id,data FROM relationships")]
        assert len(edges) == 2 and len({key for key, _ in edges}) == 2
        assert {row["invited_to_role"] for _, row in edges} == {"reader", "runner"}
        assert all(row["provenance"] == "keep" for _, row in edges)
        assert UUID(next(key for key, _ in edges if key != "invite")).version == 4

"""Migrate desktop authorization fields, roster caches and local role edges.

Dry-run by default. All rows are planned before any write; unknown roles abort
apply rather than silently widening access. The completion stamp and edits
commit together, so a retry cannot re-expand a newly intentional Reader grant.
The 0.2.243 upgrade recipe invokes this for the current instance.
"""

from __future__ import annotations

import argparse
import copy
import json
import sqlite3
from pathlib import Path

from flow_sdk.flowpad_types.enums.auth_enums import ROLE_GRANTS, ROLE_NAMES, normalize_roles

STAMP_TABLE = "role_set_migration_2026_10"


def legacy_roles(value, entity_type: str, *, runtime: bool = False) -> list[str]:
    if value is None:
        return []
    values = value.split(",") if isinstance(value, str) else value
    if not isinstance(values, list):
        raise ValueError("roles must be a string or list")
    out = []
    for raw in values:
        if not isinstance(raw, str):
            raise ValueError("role must be a string")
        role = raw.strip().lower()
        if role == "member":
            mapped = ["reader", "runner"] if entity_type == "conversation" else ["reader"]
        elif role in {"anonymous_viewer", "viewer", "guest"}:
            mapped = ["reader"]
        elif role in {"full-access", "full_access"}:
            mapped = ["admin"]
        elif role == "holder" and entity_type == "llm_endpoint":
            mapped = ["editor"]
        elif role == "spender":
            mapped = ["runner"]
        elif role == "reader" and entity_type == "llm_endpoint":
            mapped = ["runner"] if runtime else ["reader", "runner"]
        elif role in ROLE_NAMES:
            mapped = [role]
        else:
            raise ValueError(f"unknown role {raw!r}")
        out.extend(mapped)
    return normalize_roles(out)


def cached_roles(value, entity_type: str) -> list[str]:
    """An existing role set already expresses independent Reader and Runner."""
    if not isinstance(value, list):
        raise ValueError("plural roles field must be a list")
    out = []
    for role in value:
        if not isinstance(role, str):
            raise ValueError("role must be a string")
        out.extend([role] if role in ROLE_NAMES else legacy_roles(role, entity_type))
    return normalize_roles(out)


def helpdesk_staff_roles(roles: list[str], enabled: bool) -> list[str]:
    """Pre-version explicit helpdesk grants carried both ticket capabilities."""
    return normalize_roles([*roles, "reader", "runner"]) if enabled and set(roles) & {"reader", "runner"} else roles


def migrate_record(
    entity_type: str,
    original: dict,
    *,
    entity_id: str = "",
    helpdesk_projects: frozenset[str] = frozenset(),
    retained_targets: tuple[bool, ...] = (),
) -> dict:
    row = copy.deepcopy(original)
    own_helpdesk = entity_type == "project" and entity_id in helpdesk_projects
    invitation_helpdesk = row.get("target_type") == "project" and row.get("target_id") in helpdesk_projects
    for field in ("visitor_roles", "authenticated_roles", "public_roles"):
        if field in row:
            row[field] = cached_roles(row[field], entity_type)
    for field, kind in (
        ("organization_roles", "organization"),
        ("target_roles", row.get("target_type") or ""),
        ("roles_to_keep", entity_type),
    ):
        if field in row:
            row[field] = cached_roles(row[field], kind)
    for singular in ("visitor_role", "authenticated_role", "public_role"):
        if singular in row:
            plural = singular + "s"
            legacy = legacy_roles(row.pop(singular), entity_type)
            row[plural] = normalize_roles([*(row.get(plural) or []), *legacy])
    if "organization_role" in row:
        row["organization_roles"] = normalize_roles(
            [*(row.get("organization_roles") or []), *legacy_roles(row.pop("organization_role"), "organization")]
        )
    if "target_role" in row:
        row["target_roles"] = normalize_roles(
            [*(row.get("target_roles") or []), *legacy_roles(row.pop("target_role"), row.get("target_type") or "")]
        )
    if "target_roles" in row:
        row["target_roles"] = helpdesk_staff_roles(row["target_roles"], invitation_helpdesk)
    if "role_to_keep" in row:
        row["roles_to_keep"] = normalize_roles(
            [*(row.get("roles_to_keep") or []), *legacy_roles(row.pop("role_to_keep"), entity_type)]
        )
    if set(row.get("roles_to_keep") or []) - ROLE_GRANTS["owner"]:
        raise ValueError("Unassignable roles_to_keep")
    if row.get("roles_to_keep"):
        target_helpdesks = [
            str(target.get("typeid") or "").removeprefix("project-") in helpdesk_projects
            and str(target.get("typeid") or "").startswith("project-")
            for target in row.get("invitation_targets") or []
        ]
        target_helpdesks.extend(retained_targets)
        if any(target_helpdesks) and not all(target_helpdesks):
            raise ValueError("ambiguous helpdesk retained-role targets")
        row["roles_to_keep"] = helpdesk_staff_roles(
            row["roles_to_keep"],
            own_helpdesk or invitation_helpdesk or bool(target_helpdesks and all(target_helpdesks)),
        )
    for member in row.get("members") or []:
        if isinstance(member, dict) and "roles" in member:
            member["roles"] = cached_roles(member["roles"], entity_type)
        if isinstance(member, dict) and "role" in member:
            member["roles"] = normalize_roles(
                [*(member.get("roles") or []), *legacy_roles(member.pop("role"), entity_type)]
            )
        if isinstance(member, dict) and "roles" in member:
            member["roles"] = helpdesk_staff_roles(member["roles"], own_helpdesk)
    for target in row.get("invitation_targets") or []:
        if isinstance(target, dict) and "roles" in target:
            target["roles"] = cached_roles(target["roles"], str(target.get("typeid") or "").split("-", 1)[0])
        if isinstance(target, dict) and "role" in target:
            target_type = str(target.get("typeid") or "").split("-", 1)[0]
            old_role = target.pop("role")
            target["roles"] = legacy_roles(old_role, target_type)
            if target_type == "task" and old_role == "guest":
                target["is_final"] = True
        if isinstance(target, dict) and "roles" in target:
            typeid = str(target.get("typeid") or "")
            target["roles"] = helpdesk_staff_roles(
                target["roles"], typeid.startswith("project-") and typeid[len("project-") :] in helpdesk_projects
            )
    if "login_roles" in row:
        row["login_roles"] = legacy_roles(row["login_roles"], entity_type)
    return row


def _exists(conn, table: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def migrate(db_path: Path | str | None = None, *, dry_run: bool = True) -> dict:
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    if db_path is None:
        from flow_sdk.instance_settings import get_instance_settings

        db_path = get_instance_settings().db_path
    report = {"dry_run": dry_run, "records": 0, "edges": 0, "extra_edges": 0, "errors": [], "completed": False}
    if not Path(db_path).exists():
        return report
    conn = (
        sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)
        if dry_run
        else open_sqlite(str(db_path))
    )
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN" if dry_run else "BEGIN IMMEDIATE")
        if _exists(conn, STAMP_TABLE):
            report["completed"] = True
            return report
        records = []
        snapshots = []
        if _exists(conn, "entities"):
            for record in conn.execute("SELECT id, type, data FROM entities ORDER BY id"):
                try:
                    old = json.loads(record["data"] or "{}")
                    if not isinstance(old, dict):
                        raise ValueError("entity data must be an object")
                    snapshots.append((record["id"], record["type"], old))
                except (ValueError, TypeError) as exc:
                    report["errors"].append({"entity": record["id"], "error": str(exc)})
        helpdesk_projects = frozenset(
            key
            for key, kind, row in snapshots
            if kind == "project" and isinstance(row.get("helpdesk"), dict) and row["helpdesk"].get("enabled") is True
        )
        public_groups = {key for key, kind, row in snapshots if kind == "group" and row.get("name") == "public"}
        relationships = (
            list(
                conn.execute("SELECT * FROM relationships WHERE lower(type) IN ('role', 'invitedthrough') ORDER BY id")
            )
            if _exists(conn, "relationships")
            else []
        )
        retention_context = {}
        for edge in relationships:
            if edge["type"].lower() == "invitedthrough" and edge["to_type"] == "invitation":
                retention_context.setdefault(edge["to_id"], []).append(
                    edge["from_type"] == "project" and edge["from_id"] in helpdesk_projects
                )
        for key, kind, old in snapshots:
            try:
                new = migrate_record(
                    kind,
                    old,
                    entity_id=key,
                    helpdesk_projects=helpdesk_projects,
                    retained_targets=tuple(retention_context.get(key, ())),
                )
                if old != new:
                    records.append((json.dumps(new), key))
            except (ValueError, TypeError, AttributeError) as exc:
                report["errors"].append({"entity": key, "error": str(exc)})
        edges = []
        if relationships:
            for edge in relationships:
                old = dict(edge)
                try:
                    if old["type"].lower() == "invitedthrough":
                        payload = json.loads(old.get("data") or "{}")
                        targets = helpdesk_staff_roles(
                            legacy_roles(payload.get("invited_to_role"), old["from_type"]),
                            old["from_type"] == "project" and old["from_id"] in helpdesk_projects,
                        )
                        if not targets:
                            raise ValueError("invitation relationship is missing its grant")
                        mapped = [{**old, "data": json.dumps({**payload, "invited_to_role": role})} for role in targets]
                        if len(mapped) != 1 or mapped[0] != old:
                            edges.append(mapped)
                        continue

                    def side(key, kind, runtime=False):
                        value = old[key]
                        if value in {None, "*"}:
                            return [value]
                        roles = legacy_roles(value, kind, runtime=runtime)
                        entity_key = old["from_id" if key == "from_role" else "to_id"]
                        explicit = not (old["from_type"] == "group" and old["from_id"] in public_groups)
                        return helpdesk_staff_roles(
                            roles, kind == "project" and entity_key in helpdesk_projects and explicit
                        )

                    sources = side("from_role", old["from_type"])
                    if len(sources) != 1:
                        raise ValueError("ambiguous source role selector expands to multiple roles")
                    targets = side(
                        "to_role",
                        old["to_type"],
                        old["from_type"] in {"compute_node", "agent_runtime_identity", "runtime_identity"},
                    )
                    mapped = []
                    for source in sources:
                        for target in targets:
                            new = {**old, "from_role": source, "to_role": target}
                            if old["to_type"] == "task" and old["to_role"] == "guest":
                                new["is_final"] = True
                            # The denormalized columns are authoritative; keep any mirrored
                            # mapping properties in the JSON blob consistent with them.
                            payload = json.loads(old.get("data") or "{}")
                            for key in ("from_role", "to_role", "is_final"):
                                if key in payload:
                                    payload[key] = new[key]
                            new["data"] = json.dumps(payload) if payload else old.get("data")
                            mapped.append(new)
                    if len(mapped) != 1 or mapped[0] != old:
                        edges.append(mapped)
                except (ValueError, TypeError, AttributeError) as exc:
                    report["errors"].append({"edge": old["id"], "error": str(exc)})
        report.update(records=len(records), edges=len(edges), extra_edges=sum(len(items) - 1 for items in edges))
        if dry_run or report["errors"]:
            return report
        if records:
            conn.executemany("UPDATE entities SET data=? WHERE id=?", records)
        for mapped in edges:
            for i, edge in enumerate(mapped):
                keys = list(edge)
                if i == 0:
                    changed = [key for key in keys if key != "id"]
                    conn.execute(
                        f"UPDATE relationships SET {','.join(key + '=?' for key in changed)} WHERE id=?",
                        [edge[key] for key in changed] + [edge["id"]],
                    )
                else:
                    edge["id"] = mint_uuid()
                    conn.execute(
                        f"INSERT INTO relationships ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
                        [edge[key] for key in keys],
                    )
        conn.execute(f"CREATE TABLE {STAMP_TABLE} (completed INTEGER NOT NULL)")
        conn.execute(f"INSERT INTO {STAMP_TABLE} VALUES (1)")
        conn.commit()
        report["completed"] = True
        return report
    finally:
        conn.rollback()
        conn.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    report = migrate(args.db, dry_run=not args.apply)
    print(json.dumps(report))  # noqa: T201 - CLI report
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

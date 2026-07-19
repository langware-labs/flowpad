"""One-shot migration from legacy Artifact runtime records to two planes.

This module deliberately works at the persisted JSON boundary.  It can run
before the entity registry has loaded the new models, keeps Artifact ids
stable, and mints the companion local Deployment id deterministically.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.fs_origin import is_safe_rel_path
from flow_sdk.builtin.git_origin import GitOrigin

logger = logging.getLogger(__name__)

LEGACY_KIND_MAP: dict[str, str] = {
    "WEBAPP": "application.web",
    "WEBPAGE": "content.web.page",
    "APP_SERVICE": "workload.service",
    "CLOUD_SERVICE": "resource.infrastructure",
    "FUNCTION": "workload.function",
    "FILE": "content.file",
    "TEXT_FILE": "content.file.text",
    "DATA": "content.data",
}

_RETIRED_ARTIFACT_FIELDS = {
    "artifact_type",
    "generating_flow_id",
    "git_origin",
    "health",
    "metadata",
    "path",
    "port",
    "ref_type",
    "start_cmd",
}


@dataclass(frozen=True)
class ArtifactMigrationReport:
    artifacts: int = 0
    deployments: int = 0
    skipped: int = 0


def _text(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _legacy_value(data: dict[str, Any], name: str) -> Any:
    value = data.get(name)
    if value not in (None, ""):
        return value
    metadata = data.get("metadata")
    return metadata.get(name) if isinstance(metadata, dict) else None


def _git_origin(data: dict[str, Any]) -> dict[str, Any] | None:
    raw = data.get("origin") or data.get("git_origin")
    if raw is None and isinstance(data.get("metadata"), dict):
        raw = data["metadata"].get("git_origin")
    if not isinstance(raw, dict):
        return None
    candidate = dict(raw)
    candidate.setdefault("kind", "git")
    rel_path = _text(candidate.get("rel_path")) or "."
    # A useful GitOrigin must identify a repository and a safe position inside
    # it. Invalid partial/traversal payloads fall through to LocalOrigin rather
    # than poisoning the new discriminated union.
    if (
        str(candidate.get("kind") or "git").strip().lower() != "git"
        or not _text(candidate.get("provider"))
        or not _text(candidate.get("owner"))
        or not _text(candidate.get("name"))
        or not is_safe_rel_path(rel_path)
    ):
        return None
    candidate["rel_path"] = rel_path
    try:
        return GitOrigin.model_validate(candidate).model_dump(mode="json")
    except ValueError:
        return None


def _local_origin(data: dict[str, Any]) -> dict[str, Any] | None:
    raw_path = _text(data.get("path"))
    if raw_path is None:
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        return None
    # LocalOrigin is a base plus a relative placement.  Keeping the parent as
    # the base works for both file and folder artifacts and never guesses a
    # remote transport.
    if path.name:
        return {"kind": "local", "base": str(path.parent), "rel_path": path.name}
    return {"kind": "local", "base": str(path), "rel_path": "."}


def _artifact_payload(data: dict[str, Any]) -> dict[str, Any]:
    payload = {key: value for key, value in data.items() if key not in _RETIRED_ARTIFACT_FIELDS}
    legacy_kind = _text(data.get("artifact_type"))
    payload["kind"] = _text(data.get("kind")) or LEGACY_KIND_MAP.get(
        (legacy_kind or "FILE").upper(),
        "content.file",
    )
    origin = _git_origin(data) or _local_origin(data)
    if origin is not None:
        payload["origin"] = origin
    elif payload.get("origin") is None:
        payload.pop("origin", None)
    return payload


def _deployment_payload(artifact: dict[str, Any]) -> dict[str, Any] | None:
    port = _text(_legacy_value(artifact, "port"))
    start_cmd = _text(_legacy_value(artifact, "start_cmd"))
    health = _text(_legacy_value(artifact, "health"))
    if port is None and start_cmd is None and health is None:
        return None

    artifact_id = str(artifact["id"])
    deployment_id = mint_uuid(f"deployment:legacy-artifact:{artifact_id}")
    location = f"http://localhost:{port}" if port else _text(artifact.get("path"))
    labels = {
        key: value
        for key, value in {
            "flowpad.runtime.port": port,
            "flowpad.runtime.start_cmd": start_cmd,
            "flowpad.runtime.health": health,
        }.items()
        if value is not None
    }
    resource = None
    if port:
        resource = {
            "full_resource_name": f"local://localhost:{port}",
            "asset_type": "flowpad.local/Process",
            "provider_uid": port,
        }
    message = "Imported from legacy Artifact runtime fields"
    return {
        "id": deployment_id,
        "type": "deployment",
        "name": f"{_text(artifact.get('name')) or 'Artifact'} (local)",
        "kind": "local.runtime.web" if port else "local.runtime",
        "artifact_id": artifact_id,
        "artifact_link_source": "manual",
        "target": {
            "provider": "local",
            "scope": _text(artifact.get("project_id")) or "machine",
            **({"location": location} if location else {}),
        },
        **({"resource": resource} if resource else {}),
        "status": {"sync_state": "current", "provider_state": "configured", "message": message},
        "provider_labels": labels,
        "source_revision": (_git_origin(artifact) or {}).get("head_commit"),
        "project_id": artifact.get("project_id"),
        "parent_type_id": None,
    }


def migrate_artifacts(conn: sqlite3.Connection, *, dry_run: bool = False) -> tuple[ArtifactMigrationReport, list[dict[str, Any]]]:
    """Rewrite every legacy Artifact row and create its local Deployment.

    Returns a report and the journal entries.  Callers own the transaction and
    persist the journal before committing for crash diagnosis/recovery.
    """

    rows = conn.execute(
        "SELECT id, type, namespace, key, uname, type_uname, created_by, created_date, "
        "updated_by, updated_date, created_through, updated_through, schema_version, data, record_data_ref "
        "FROM entities WHERE type = 'artifact'"
    ).fetchall()
    artifacts = deployments = skipped = 0
    journal: list[dict[str, Any]] = []

    for row in rows:
        columns = (
            "id", "type", "namespace", "key", "uname", "type_uname", "created_by", "created_date",
            "updated_by", "updated_date", "created_through", "updated_through", "schema_version", "data",
            "record_data_ref",
        )
        stored = dict(zip(columns, row, strict=True))
        try:
            before = json.loads(stored.get("data") or "{}")
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not isinstance(before, dict):
            skipped += 1
            continue
        before.setdefault("id", stored["id"])
        before.setdefault("type", "artifact")
        after = _artifact_payload(before)
        deployment = _deployment_payload(before)

        changed = after != before
        if not changed and deployment is None:
            skipped += 1
            continue

        journal.append({"id": stored["id"], "before": before, "after": after, "deployment": deployment})
        if changed:
            artifacts += 1
            if not dry_run:
                conn.execute(
                    "UPDATE entities SET data = ? WHERE id = ? AND type = 'artifact'",
                    (json.dumps(after, separators=(",", ":"), sort_keys=True), stored["id"]),
                )

        if deployment is not None:
            exists = conn.execute(
                "SELECT 1 FROM entities WHERE id = ? AND type = 'deployment'",
                (deployment["id"],),
            ).fetchone()
            if exists is None:
                deployments += 1
                if not dry_run:
                    conn.execute(
                        "INSERT INTO entities "
                        "(id, type, namespace, key, uname, type_uname, created_by, created_date, updated_by, "
                        "updated_date, created_through, updated_through, schema_version, data, record_data_ref) "
                        "VALUES (?, 'deployment', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
                        (
                            deployment["id"], stored["created_by"], stored["created_date"], stored["updated_by"],
                            stored["updated_date"], stored["created_through"], stored["updated_through"],
                            stored["schema_version"], json.dumps(deployment, separators=(",", ":"), sort_keys=True),
                        ),
                    )

    return ArtifactMigrationReport(artifacts, deployments, skipped), journal


def run_artifact_deployment_migration(db_path: Path, *, dry_run: bool = False) -> ArtifactMigrationReport:
    """Back up, journal, migrate, and commit one database idempotently."""

    if not db_path.exists():
        return ArtifactMigrationReport()
    conn = sqlite3.connect(db_path)
    try:
        preview, preview_journal = migrate_artifacts(conn, dry_run=True)
        if dry_run or not preview_journal:
            return preview

        backup = db_path.with_suffix(db_path.suffix + ".pre-artifact-deployment.bak")
        if not backup.exists():
            backup_conn = sqlite3.connect(backup)
            try:
                conn.backup(backup_conn)
            finally:
                backup_conn.close()

        report, journal = migrate_artifacts(conn)
        journal_path = db_path.with_suffix(db_path.suffix + ".artifact-deployment-journal.json")
        if not journal_path.exists():
            journal_path.write_text(json.dumps(journal, indent=2, sort_keys=True), encoding="utf-8")
        conn.commit()
        logger.info(
            "[artifact-deployment] migrated artifacts=%d deployments=%d skipped=%d",
            report.artifacts,
            report.deployments,
            report.skipped,
        )
        return report
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


__all__ = [
    "ArtifactMigrationReport",
    "LEGACY_KIND_MAP",
    "migrate_artifacts",
    "run_artifact_deployment_migration",
]

"""Drop desktop-local Docker compute nodes; containers now enroll via `flow connect --docker`.

Entry point: ``run()``. The runner calls it with no args, once, on upgrade.
Idempotent — a clean instance reports nothing to remove.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_08_drop_docker_compute_nodes import drop

    report = drop(dry_run=False)
    summary = {"rows_deleted": report.rows_deleted, "relationships_deleted": report.relationships_deleted}
    if not report.rows_deleted:
        print("docker compute nodes: nothing to remove.")  # noqa: T201 — migration output is user-facing
        return summary
    print(  # noqa: T201
        f"docker compute nodes: removed {report.rows_deleted} legacy node(s) — "
        "use `flow connect --docker <container>`."
    )
    for row in report.rows:
        print(f"  {row['name'] or row['id']}")  # noqa: T201
    return summary

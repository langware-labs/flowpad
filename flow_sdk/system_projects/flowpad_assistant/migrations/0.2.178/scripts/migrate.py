"""0.2.178 — authored drivers extend their source family; a credential is a ``credential`` again.

Runs once on upgrade, in order:

* ``migration_2026_09_source_families`` — the loader now refuses a driver class that extends ``Source`` /
  ``CollectionSource`` without ``ObjectSource``, ``RecordSource`` or ``MessageSource``; without this pass a
  driver written in a project before this release stops loading.
* ``migration_2026_09_credential_noun`` — declared ``secret_pack/<name>`` folders move to
  ``credential/<name>/credential.json``, and authored drivers importing ``Credentials`` get
  ``ResolvedSecrets``.

Idempotent — a converted instance reports zeros.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations import migration_2026_09_credential_noun, migration_2026_09_source_families

    families = migration_2026_09_source_families.migrate(dry_run=False)
    noun = migration_2026_09_credential_noun.migrate(dry_run=False)
    for line in [*families.lines(), *noun.lines()]:
        print(line)  # noqa: T201 — migration output is user-facing
    return {
        "drivers_converted": sum(families.converted.values()),
        "drivers_unconverted": sum(len(p) for p in families.unconverted.values()),
        "credentials_moved": len(noun.moved),
        "credential_conflicts": len(noun.conflicts),
    }

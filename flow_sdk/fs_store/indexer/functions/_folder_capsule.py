"""The ``.flow/id`` folder-entity id capsule.

A folder-backed entity stores its id in ``<folder>/.flow/id`` — a single-line
UTF-8 file holding the canonical v4/v5 UUID. This is the portable, move-safe
capsule: the id travels with the folder on share/copy and survives a rename (it
lives in the bytes, not the path), and it is the only place a main-doc-less
folder (e.g. a project) can carry its id. ``.flow/id`` is CONTENT, not ignorable
— it must travel; do not gitignore it (downstream repos that blanket-ignore
``.flow/`` must add ``!.flow/id``).

Mirrors the file/frontmatter capsule (``_frontmatter.adopt_or_mint_id``): adopt a
valid id, else mint a fresh v4 and write it. Deriving an id from the folder's
name/path is retired — that was the cross-machine collision source.
"""

from __future__ import annotations

from pathlib import Path


def _capsule_path(folder: Path) -> Path:
    return folder / ".flow" / "id"


def read_folder_capsule_id(folder: Path) -> str | None:
    """Adopt the folder's ``.flow/id`` capsule id (validated v4/v5), else ``None``.

    Routes through ``adopt_entity_id`` so a foreign/garbage capsule id (a v7, a
    hand-typed token) is rejected → ``None`` and the caller mints a fresh v4.
    """
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

    try:
        raw = _capsule_path(folder).read_text(encoding="utf-8")
    except OSError:
        return None
    return adopt_entity_id(raw)


def write_folder_capsule_id(folder: Path, entity_id: str) -> bool:
    """Write ``entity_id`` into ``<folder>/.flow/id`` — returns whether it persisted.

    Uses ``write_text_if_changed`` so an unchanged id never churns mtime/index
    hash. Swallows ``OSError`` (read-only mounts) — a capsule write must never
    abort an index run — and returns ``False`` in that case so callers can fall
    back without a confirming re-read.
    """
    from flow_sdk.fs_store.fs_record import write_text_if_changed  # noqa: PLC0415

    try:
        write_text_if_changed(_capsule_path(folder), entity_id.strip() + "\n")
        return True
    except OSError:
        return False


def folder_capsule_gen_id(folder: Path, *candidate_raw_ids: object) -> str:
    """Resolve a folder entity's id (the one place the folder-capsule precedence
    lives). Adopt the ``.flow/id`` capsule; else adopt the first VALID (v4/v5)
    legacy candidate — a frontmatter/manifest id — and BACKFILL it into the
    capsule (migrating the entity onto ``.flow/id`` without changing its id);
    else mint a fresh v4 and write it. A read-only folder (write swallowed) falls
    back to a stable uuid5(path) so scans stay idempotent.

    Each folder type passes its raw legacy id candidates in precedence order; the
    helper validates them, so callers hand over the raw values unadopted.
    """
    from flow_sdk.fs_store.identifier import adopt_entity_id, mint_uuid  # noqa: PLC0415

    cap = read_folder_capsule_id(folder)
    if cap:
        return cap
    for raw in candidate_raw_ids:
        adopted = adopt_entity_id(raw)
        if adopted:
            write_folder_capsule_id(folder, adopted)
            return adopted
    new_id = mint_uuid()  # no key → uuid4
    if write_folder_capsule_id(folder, new_id):
        return new_id
    return mint_uuid(str(folder.resolve()))

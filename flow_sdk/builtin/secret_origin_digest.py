"""Remembering that a value changed, without remembering the value.

The Secrets card wants to warn "this value is not what you provided" — a
`.env.local` is hand-edited constantly, and a stale binding is worth flagging.
That needs a per-machine memory of what the value *was*, which is the one thing
this system is otherwise built never to keep.

So: a salted digest, stored in the per-instance encrypted ``sodot``.

**The salt is load-bearing, not decoration.** An unsalted SHA-256 of a short or
low-entropy secret is brute-forceable from a wordlist, so an unsalted digest is
not value-free in any meaningful sense — it is a slow copy of the secret. The
salt is per-instance, random, and lives only in the encrypted store.

Where it is kept matters as much as what it is. ``sodot`` is unreachable from
``reference_json()``, ``_hub_body()``, the indexer, and git *by construction* —
so a digest cannot leak into a shared payload through a future refactor, rather
than merely being unlikely to. ``_FORBIDDEN_VALUE_KEYS`` also names the digest
keys, so an attempt to put one in a reference json fails loudly.
"""

from __future__ import annotations

import hashlib
import logging
import secrets as _secrets
from typing import Optional

logger = logging.getLogger(__name__)

_SALT_NAME = "__flowpad_digest_salt__"
#: Process cache. Reading the salt decrypts the whole sodot, and a drift check
#: over S secrets would otherwise pay that 2-4 times per secret.
_SALT_MEMO: Optional[str] = None
_DIGEST_PREFIX = "__flowpad_digest__"
_DIGEST_LEN = 16


def digest_name(project_id: str, env_var: str) -> str:
    """The ``sodot`` entry name holding one secret's digest."""
    return f"{_DIGEST_PREFIX}:{project_id}:{env_var}"


def _instance_salt() -> Optional[str]:
    """The per-instance digest salt, minted on first use. ``None`` when the
    encrypted store isn't available (secrets not enabled) — in which case drift
    simply isn't tracked, which is a fine degradation."""
    global _SALT_MEMO
    if _SALT_MEMO is not None:
        return _SALT_MEMO

    from flow_sdk.cli.auth.secrets import read_secret, write_secret  # noqa: PLC0415

    try:
        existing = read_secret(_SALT_NAME)
        if existing:
            _SALT_MEMO = existing
            return existing
        salt = _secrets.token_hex(16)
        write_secret(_SALT_NAME, salt, "Salt for value-change digests. Not a credential.")
        _SALT_MEMO = salt
        return salt
    except Exception as e:  # noqa: BLE001
        logger.debug("[secret-digest] salt unavailable: %s", e)
        return None


def compute_digest(value: str) -> Optional[str]:
    """Salted, truncated digest of ``value``. ``None`` when unavailable."""
    salt = _instance_salt()
    if salt is None:
        return None
    return hashlib.sha256(f"{salt}:{value}".encode("utf-8")).hexdigest()[:_DIGEST_LEN]


def record_digest(project_id: str, env_var: str, value: str) -> None:
    """Remember what the value is now. Best-effort; never raises."""
    from flow_sdk.cli.auth.secrets import write_secret  # noqa: PLC0415

    digest = compute_digest(value)
    if digest is None:
        return
    try:
        write_secret(digest_name(project_id, env_var), digest, "Value-change digest (not a credential)")
    except Exception as e:  # noqa: BLE001
        logger.debug("[secret-digest] could not record digest for %s: %s", env_var, e)


async def clear_digest(project_id: str, env_var: str) -> None:
    """Forget the baseline. Best-effort; never raises.

    Paired with deleting the value: a digest that outlives its secret would make
    the next value someone provides look like a CHANGE to a value that is no
    longer there, and raise a drift warning about nothing.

    Async, unlike its ``record_`` sibling, only because ``delete_secret`` is.
    """
    from flow_sdk.cli.auth.secrets import delete_secret  # noqa: PLC0415

    try:
        await delete_secret(digest_name(project_id, env_var))
    except Exception as e:  # noqa: BLE001
        logger.debug("[secret-digest] could not clear digest for %s: %s", env_var, e)


def read_digest(project_id: str, env_var: str) -> Optional[str]:
    from flow_sdk.cli.auth.secrets import read_secret  # noqa: PLC0415

    try:
        return read_secret(digest_name(project_id, env_var))
    except Exception:  # noqa: BLE001
        return None


def check_drift(project_id: str, env_var: str, value: str) -> bool:
    """Has ``value`` changed since it was last recorded?

    First sighting records and reports no drift — we cannot claim a change we
    never observed a baseline for.
    """
    current = compute_digest(value)
    if current is None:
        return False
    known = read_digest(project_id, env_var)
    if known is None:
        record_digest(project_id, env_var, value)
        return False
    return known != current

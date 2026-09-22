"""The id of a saved shape — policy here, the carrier injected.

§6 of ``docs/snippets/data-spec.md``: **a spec has no ``id`` field.** Identity
is not content; it is a CARRIER written beside the document. A spec that
declared an ``id`` would make two specs with the same content unequal, and a
copied folder a second entity.

The POLICY lives here because ``api.api_types.identifier`` is already a
dependency ``data_spec`` is allowed (three modules import it):

* mint through the one minter, never ``uuid4()`` at a call site
* adopt a found id ONLY if it validates — a hand-authored or foreign id is
  ignored rather than becoming an entity id
* mint ONCE: a second save reuses what is there, so a folder keeps its identity

The CARRIER — which file, and where — is injected, because WHICH carrier a type
uses is a ``TypeInfo`` fact and ``TypeInfo`` sits above this layer. The default
is the folder capsule, written through ``flow_sdk.capsules`` — the module that
OWNS that file, including its envelope, its lock and its atomic write.

Writing that file by hand is the one thing this module must not do: the capsule
is ``{"version": 1, "data": {"id": …}}``, and a bare ``{"id": …}`` is not just a
different spelling. A hand-written file makes ``read`` find no id, so a save
into an existing asset folder mints a fresh one and overwrites the real
capsule — re-keying an entity that was already named.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Protocol

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.capsules.data import CapsuleData
from flow_sdk.capsules.folder import FolderCapsule as _Capsule

#: The capsule an asset folder keeps its identity in. One name, one version —
#: both owned by ``flow_sdk.capsules``.
IDENTITY = "identity"
CAPSULE_VERSION = 1


class Carrier(Protocol):
    """Reads and writes the id beside a saved shape."""

    def read(self, root: Path) -> Optional[str]:
        """The id already there, or ``None``."""

    def stamp(self, root: Path, entity_id: str) -> None:
        """Record *entity_id* for this folder."""


class FolderCapsule:
    """``<root>/.flow/capsules/identity.json``, through the capsule store.

    A sidecar rather than a key in the document, so the document stays pure
    content and a spec never has to declare a field it does not own.
    """

    def read(self, root: Path) -> Optional[str]:
        try:
            capsule = _Capsule(root).read(IDENTITY)
        except Exception:  # noqa: BLE001 — an unreadable carrier is an absent one
            return None
        found = capsule.data.get("id") if capsule is not None else None
        # Validate on ADOPT: an id from outside the minter is a claim, not a fact.
        return found if isinstance(found, str) and is_valid_entity_id(found) else None

    def stamp(self, root: Path, entity_id: str) -> None:
        # ``write_if_absent``: two writers racing a new folder must agree on one
        # id, and a stamp must never replace an identity that already exists.
        _Capsule(root).write_if_absent(
            IDENTITY, CapsuleData(version=CAPSULE_VERSION, data={"id": entity_id})
        )


def ensure_id(root: Path, carrier: Optional[Carrier] = None) -> str:
    """This folder's id: the one already there, or a newly minted one.

    Idempotent on purpose — saving twice must not re-key an entity, which is
    the difference between a folder that can be re-saved and one that forks
    every time it is written.
    """
    holder = carrier or FolderCapsule()
    found = holder.read(root)
    if found:
        return found
    minted = str(mint_uuid())
    holder.stamp(root, minted)
    return minted


__all__ = ["CAPSULE_VERSION", "Carrier", "FolderCapsule", "IDENTITY", "ensure_id"]

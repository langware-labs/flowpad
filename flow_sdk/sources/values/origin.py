"""``CloudOrigin`` — the identity of one resource: ``(kind, namespace, key)``.

One value names a local file, a Slack message, a Drive object or a Jira issue alike.
``kind`` is the system or addressing scheme (``slack``, ``gmail``, ``local``), ``namespace``
the account/store and collection scope within it (``<workspace>/<channel>``, ``<address>``,
a bucket, a root), and ``key`` the resource within that scope. ``url`` is browser metadata
only: two origins that differ solely in ``url`` are the same resource, hash the same, and
may carry different links.

The value is frozen and does no I/O. Drivers own the encodings; the value never parses,
trims or normalizes what it is given — an empty identity component is the one refusal.

Rows written before the triple existed carried ``external_id`` (→ ``key``) and a
``provider`` (the transport, which is not identity and is dropped). Such a dict lifts on
read; ``namespace`` comes from the validation context (``legacy_namespace``) or falls back
to :data:`LEGACY_NAMESPACE`. A dict in the current shape gets no such tolerance.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import ValidationInfo, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values._types import NonBlank

#: The namespace a pre-triple origin lifts to when nothing can say better. It is a real,
#: valid namespace — such an origin still compares and hashes — but it identifies nothing
#: beyond "written before scopes existed".
LEGACY_NAMESPACE = "legacy"


class CloudOrigin(DataSpec):
    spec_kind: ClassVar[str] = "source.origin"

    kind: NonBlank
    namespace: NonBlank
    key: NonBlank
    url: Optional[NonBlank] = None

    @model_validator(mode="before")
    @classmethod
    def _lift_legacy(cls, value: Any, info: ValidationInfo) -> Any:
        if not isinstance(value, dict):
            return value
        if "external_id" not in value and "provider" not in value and value.get("url") != "":
            return value
        lifted = dict(value)
        if "key" not in lifted and "external_id" in lifted:
            lifted["key"] = lifted["external_id"]
        lifted.pop("external_id", None)
        lifted.pop("provider", None)
        if lifted.get("url") == "":
            lifted["url"] = None
        if "external_id" in value and not lifted.get("namespace"):
            lifted["namespace"] = (info.context or {}).get("legacy_namespace") or LEGACY_NAMESPACE
        return lifted

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, CloudOrigin):
            return NotImplemented
        return (self.kind, self.namespace, self.key) == (other.kind, other.namespace, other.key)

    def __hash__(self) -> int:
        return hash((self.kind, self.namespace, self.key))

    def __repr__(self) -> str:
        return f"CloudOrigin({self.kind}, {self.namespace}, {self.key})"


__all__ = ["LEGACY_NAMESPACE", "CloudOrigin"]

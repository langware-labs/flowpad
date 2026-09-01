"""Canonical, context-free virtual-filesystem locator.

``VFSPath`` parses and serializes resource identity only. Resolving an
unqualified request path to a user or compute node belongs to the request
adapter (``EntityFSReqInfo.from_request_info``), never to this value object.
"""

from __future__ import annotations

import re
from typing import TypedDict

from flow_sdk.fs_store.type_id import TypeId


class ParsedVFSURI(TypedDict):
    protocol: str | None
    type: str | None
    uuid: str | None
    path: str | None
    query: str | None
    fragment: str | None


_PROTOCOL_PATTERN = re.compile(r"^(?P<protocol>[a-zA-Z][a-zA-Z0-9+.-]*)://")


def parse_custom_uri(uri: str | None) -> ParsedVFSURI:
    """Parse the supported VFS URI parts without consulting ambient context."""

    parsed: ParsedVFSURI = {
        "protocol": None,
        "type": None,
        "uuid": None,
        "path": None,
        "query": None,
        "fragment": None,
    }
    if not uri:
        return parsed

    value = uri
    protocol_match = _PROTOCOL_PATTERN.match(value)
    if protocol_match:
        parsed["protocol"] = protocol_match.group("protocol")
        value = value[protocol_match.end() :]

    fragment_at = value.find("#")
    if fragment_at >= 0:
        parsed["fragment"] = value[fragment_at + 1 :]
        value = value[:fragment_at]

    query_at = value.find("?")
    if query_at >= 0:
        parsed["query"] = value[query_at + 1 :]
        value = value[:query_at]

    first_slash = value.find("/")
    candidate = value if first_slash < 0 else value[:first_slash]
    try:
        typeid = TypeId(candidate)
    except (IndexError, TypeError, ValueError):
        typeid = None

    if typeid is not None:
        parsed["type"] = typeid.type
        parsed["uuid"] = typeid.id
        parsed["path"] = "" if first_slash < 0 else value[first_slash:]
    else:
        parsed["path"] = value
    return parsed


class VFSPath:
    """Typed identity for a resource in the virtual filesystem."""

    VFS_PATH_PROTOCOL = "vfs"

    def __init__(self, vfs_path: str | None = None) -> None:
        self._raw_path = vfs_path
        parsed = parse_custom_uri(vfs_path)
        self.protocol = parsed["protocol"]
        if self.protocol and self.protocol != self.VFS_PATH_PROTOCOL:
            raise ValueError(f"Unsupported protocol: {self.protocol}")
        self.type = parsed["type"]
        self.uuid = parsed["uuid"]
        self.entity_sub_path = (parsed["path"] or "").lstrip("/")
        self.query = parsed["query"]
        self.fragment = parsed["fragment"]

    def is_absolute(self) -> bool:
        return self.typeid is not None

    @classmethod
    def from_entity_path(cls, typeid: TypeId, entity_vfs_path: str = "/") -> VFSPath:
        return cls(f"{typeid}/{entity_vfs_path.lstrip('/')}")

    @property
    def typeid(self) -> TypeId | None:
        if not self.type or not self.uuid:
            return None
        return TypeId(type=self.type, id=self.uuid)

    @property
    def entity_subpath(self) -> str:
        return self.entity_sub_path

    @property
    def abs_path(self) -> str:
        """Protocol-free canonical locator: ``<TypeId>/<entity-sub-path>``."""

        typeid = self.typeid
        if not typeid:
            return self.entity_sub_path
        return f"{typeid}/{self.entity_sub_path}" if self.entity_sub_path else f"{typeid}/"

    @property
    def abs_vfspath(self) -> str:
        """Backward-compatible name for :attr:`abs_path`."""

        return self.abs_path

    @property
    def uri(self) -> str:
        return f"{self.VFS_PATH_PROTOCOL}://{self.abs_path}"

    @property
    def filename(self) -> str:
        return self.entity_sub_path.rsplit("/", 1)[-1] if self.entity_sub_path else ""

    def __str__(self) -> str:
        return self.abs_path

    def __eq__(self, other: object) -> bool:
        return isinstance(other, VFSPath) and self.abs_path == other.abs_path

    def __hash__(self) -> int:
        return hash(self.abs_path)

"""Portable named metadata capsules for file and folder assets."""

from .base import AssetCapsule, FileCapsule
from .code_comment import (
    CodeCommentCapsule,
    restore_capsule_blocks,
    snapshot_capsule_blocks,
    strip_capsule_blocks,
)
from .data import CapsuleData, CapsuleSpec, JsonValue, validate_capsule_name
from .errors import (
    CapsuleConflictError,
    CapsuleError,
    DuplicateCapsuleError,
    InvalidCapsuleNameError,
    MalformedCapsuleError,
    ReadOnlyCapsuleError,
    UnsupportedCapsuleFormatError,
    UnsupportedCapsuleVersionError,
)
from .folder import FolderCapsule

__all__ = [
    "AssetCapsule", "CapsuleConflictError", "CapsuleData", "CapsuleError",
    "CapsuleSpec", "CodeCommentCapsule", "DuplicateCapsuleError", "FileCapsule",
    "FolderCapsule", "InvalidCapsuleNameError", "JsonValue", "MalformedCapsuleError",
    "ReadOnlyCapsuleError", "UnsupportedCapsuleFormatError",
    "UnsupportedCapsuleVersionError", "restore_capsule_blocks",
    "snapshot_capsule_blocks", "strip_capsule_blocks", "validate_capsule_name",
]

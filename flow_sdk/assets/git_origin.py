"""Secret-free Git coordinates used by portable asset contracts."""

from __future__ import annotations

import re
import uuid
from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.utils.git_identity import canonical_git_origin_repo_key

_GITHUB_COMPONENT_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")
_HEAD_RE = re.compile(r"^[0-9a-f]{40}$")


class PortableGitOrigin(BaseModel):
    """Strict, credential-free coordinates for one released Git asset."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["git"] = "git"
    provider: Literal["github"]
    owner: str
    name: str
    branch: str
    head_commit: str
    rel_path: str

    @field_validator("owner", "name")
    @classmethod
    def _validate_repo_component(cls, value: str) -> str:
        value = value.strip()
        if not value or not _GITHUB_COMPONENT_RE.fullmatch(value):
            raise ValueError("owner and name must be GitHub repository components")
        if value.endswith(".git") or value in {".", ".."}:
            raise ValueError("repository components must be canonical")
        return value

    @field_validator("branch")
    @classmethod
    def _validate_branch(cls, value: str) -> str:
        value = value.strip()
        if (
            not value
            or value.startswith(("-", ".", "/"))
            or value.endswith(("/", ".", ".lock"))
            or ".." in value
            or "@{" in value
            or "\\" in value
            or any(ch.isspace() or ord(ch) < 32 for ch in value)
            or any(ch in value for ch in "~^:?*[#&=")
        ):
            raise ValueError("branch must be a concrete safe Git ref")
        return value

    @field_validator("head_commit")
    @classmethod
    def _validate_head(cls, value: str) -> str:
        if not _HEAD_RE.fullmatch(value):
            raise ValueError("head_commit must be exactly 40 lowercase hexadecimal characters")
        return value

    @field_validator("rel_path")
    @classmethod
    def _validate_rel_path(cls, value: str) -> str:
        if not isinstance(value, str) or not value or value != value.strip():
            raise ValueError("rel_path must be a non-empty repository-relative path")
        if "\\" in value or "?" in value or "#" in value or "\x00" in value:
            raise ValueError("rel_path contains forbidden characters")
        path = PurePosixPath(value)
        if path.is_absolute() or value.startswith("/") or value.endswith("/"):
            raise ValueError("rel_path must be repository-relative and normalized")
        if path.as_posix() != value or any(part in {"", "..", ".git"} for part in path.parts):
            raise ValueError("rel_path must be normalized and may not traverse or enter .git")
        if len(path.parts[0]) >= 2 and path.parts[0][1] == ":":
            raise ValueError("rel_path may not contain a drive-qualified path")
        return value

    def clone_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}.git"

    def key(self) -> str:
        """Retain the legacy branch-independent asset-position key."""
        remote_key = canonical_git_origin_repo_key(self.provider, self.owner, self.name)
        rel = PurePosixPath(self.rel_path).as_posix()
        return mint_uuid(key=f"{remote_key}:{rel}", namespace=uuid.NAMESPACE_URL)

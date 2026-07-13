"""Artifact entity representing filesystem entities or references created during execution."""

import logging
import os
from enum import Enum
from pathlib import Path
from typing import Any, ClassVar, Dict, List, Optional
from uuid import uuid4

from pydantic import BaseModel

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.git_origin import GitOrigin, is_safe_rel_path
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

logger = logging.getLogger(__name__)


def _artifact_git_origin(data: dict) -> GitOrigin | None:
    raw = data.get("git_origin")
    if raw is None and isinstance(data.get("metadata"), dict):
        raw = data["metadata"].get("git_origin")
    if raw is None:
        return None
    try:
        return raw if isinstance(raw, GitOrigin) else GitOrigin.model_validate(raw)
    except Exception:
        return None


async def _index_checkout(root: Path, *, project_id: str | None = None) -> None:
    try:
        from flow_sdk.fs_store.fs_ref import FSRef
        from flow_sdk.fs_store.indexer import IndexerOptions, get_shared_indexer
        from flow_sdk.fs_store.record_types import RecordType

        await get_shared_indexer().index(
            IndexerOptions(
                roots=(FSRef(root, record_type=RecordType.REAL_PROJECT_CWD, scope="project", project_id=project_id),),
                force=True,
                verbose=False,
                include_temp=True,
            )
        )
    except Exception:
        logger.warning("[artifact] failed to index checkout %s", root, exc_info=True)


# ref to physical
class ArtifactReferenceType(str, Enum):
    """Types of codebase references."""

    FILE = "FILE"
    FOLDER = "FOLDER"
    GLOB = "GLOB"  # File pattern/glob
    REFERENCE = "REFERENCE"  # External reference
    URL = "URL"  # URL reference


# logical
class ArtifactType(str, Enum):
    """Types of artifacts that can be produced (replaces ResultType from semantic analyzer)."""

    WEBPAGE = "WEBPAGE"
    FUNCTION = "FUNCTION"
    APP_SERVICE = "APP_SERVICE"
    CLOUD_SERVICE = "CLOUD_SERVICE"
    FILE = "FILE"
    DATA = "DATA"
    TEXT_FILE = "TEXT_FILE"
    WEBAPP = "WEBAPP"  # Web application running on a port


class ArtifactRelationType(str, Enum):
    """Types of relationships between artifacts."""

    TEST_OF = "test_of"
    IMPLEMENTATION_OF = "implementation_of"
    DEPENDS_ON = "depends_on"
    CONTAINS = "contains"
    REFERENCES = "references"


class ArtifactDescriptor(BaseModel):
    """Descriptor for artifact types with human-readable descriptions."""

    artifact_type: ArtifactType
    description: str


# Array of artifact descriptors
artifact_descriptors: List[ArtifactDescriptor] = [
    ArtifactDescriptor(
        artifact_type=ArtifactType.WEBPAGE,
        description="A web page or web-based user interface that can be accessed via browser",
    ),
    ArtifactDescriptor(
        artifact_type=ArtifactType.FUNCTION, description="A reusable function or method that performs a specific task"
    ),
    ArtifactDescriptor(
        artifact_type=ArtifactType.APP_SERVICE, description="An application service or microservice component"
    ),
    ArtifactDescriptor(
        artifact_type=ArtifactType.CLOUD_SERVICE, description="A cloud-hosted service or infrastructure component"
    ),
    ArtifactDescriptor(artifact_type=ArtifactType.FILE, description="A general file or document in the filesystem"),
    ArtifactDescriptor(artifact_type=ArtifactType.DATA, description="Raw data, dataset, or structured data output"),
    ArtifactDescriptor(
        artifact_type=ArtifactType.TEXT_FILE,
        description="Any file containing text, maybe with .txt extension or no extension at all",
    ),
    ArtifactDescriptor(
        artifact_type=ArtifactType.WEBAPP,
        description="A web application running on a specific port that can be accessed via browser",
    ),
]


class CodeRef(Entity):
    """Reference to a piece of code - can be file, folder, glob pattern, or external reference."""

    type: str = APIField(default=BuiltinEntityType.CODE_REF.value)
    name: str = APIField(description="Display name of the code reference")
    ref_type: ArtifactReferenceType = APIField(description="Type of reference (FILE, FOLDER, GLOB, REFERENCE)")
    path: str = APIField(description="Filesystem path, pattern, or URL")
    description: Optional[str] = APIField(default=None, description="Human-readable description")
    metadata: Optional[Dict[str, Any]] = APIField(default=None, description="Additional metadata")

    def __init__(self, **data):
        # Generate ID if not provided
        if "id" not in data:
            data["id"] = str(uuid4())
        super().__init__(**data)

    @property
    def file_type(self) -> Optional[str]:
        """Extract file extension from path, returns None for non-files."""
        if self.ref_type != ArtifactReferenceType.FILE:
            return None

        import os

        _, ext = os.path.splitext(self.path)
        return ext[1:] if ext else None  # Remove leading dot


class Artifact(CodeRef):
    """Represents a filesystem entity or reference created during execution.

    Inherits from CodeRef to provide code reference capabilities,
    and adds artifact-specific metadata like type and generating flow.
    """

    type: str = APIField(default=BuiltinEntityType.ARTIFACT.value)
    artifact_type: ArtifactType = APIField(description="Type of artifact content")
    generating_flow_id: Optional[str] = APIField(default=None, description="ID of the flow that created this artifact")
    git_origin: Optional[GitOrigin] = APIField(
        default=None,
        description="Git provenance and repo-relative placement for git-backed artifacts",
    )

    # Service control attributes (for app_service and webapp types)
    port: Optional[str] = APIField(default=None, description="Port number for services")
    start_cmd: Optional[str] = APIField(default=None, description="Command to start/restart the service")
    health: Optional[str] = APIField(default=None, description="Health check endpoint path")

    async def setup_on_receive(self, *, project_id=None, workdir=None) -> dict:
        """The per-``artifact_type`` reception decision, owned here (not at the FE
        call site): only a WEBAPP artifact is *set up* — served + shown in Vibe via
        the ``artifact-setup`` skill. Any other artifact kind is a produced file, so
        its DisplayTarget just opens that file by path. Prevents a non-webapp
        artifact from wrongly spawning a setup session on install."""
        if self.artifact_type == ArtifactType.WEBAPP:
            return await super().setup_on_receive(project_id=project_id, workdir=workdir)
        from flow_sdk.core.display_target import DisplayTargetKind, _entity_payload  # noqa: PLC0415
        if self.path:
            return {"kind": DisplayTargetKind.VFS, "path": self.path}
        return _entity_payload(self)

    def __init__(self, **data):
        # Generate ID if not provided
        if "id" not in data:
            data["id"] = str(uuid4())
        # Extract service control fields from metadata if present
        metadata = data.get("metadata") or {}
        if metadata:
            if "port" in metadata and "port" not in data:
                data["port"] = metadata.get("port")
            if "start_cmd" in metadata and "start_cmd" not in data:
                data["start_cmd"] = metadata.get("start_cmd")
            if "health" in metadata and "health" not in data:
                data["health"] = metadata.get("health")
            if "git_origin" in metadata and "git_origin" not in data:
                data["git_origin"] = metadata.get("git_origin")
        if data.get("git_origin") is not None:
            metadata = dict(metadata)
            try:
                origin = data["git_origin"] if isinstance(data["git_origin"], GitOrigin) else GitOrigin.model_validate(data["git_origin"])
                metadata["git_origin"] = origin.model_dump(mode="json")
                data["git_origin"] = origin
                data["metadata"] = metadata
            except Exception:
                pass
        super().__init__(**data)

    def _needs_wizard(self, origin: GitOrigin, reason: str) -> dict:
        return {
            "kind": "needs_wizard",
            "artifact": self.model_dump(mode="json"),
            "gitOrigin": origin.model_dump(mode="json"),
            "reason": reason,
        }

    async def _ready_from_checkout(self, checkout_root: Path, project) -> dict:
        from flow_sdk.utils.git import git_pull

        origin = self.git_origin
        if origin is None:
            return {"kind": "error", "message": "Artifact has no git_origin"}
        if not is_safe_rel_path(origin.rel_path):
            return {"kind": "error", "message": "Artifact git_origin has an unsafe rel_path"}

        ok, msg = await git_pull(str(checkout_root), branch=origin.branch or None)
        if not ok:
            return self._needs_wizard(origin, msg or "Could not fetch repository")

        rel = "." if origin.rel_path == "." else origin.rel_path
        asset_path = (checkout_root / rel).resolve()
        try:
            asset_path.relative_to(checkout_root.resolve())
        except ValueError:
            return {"kind": "error", "message": "Resolved artifact path escapes checkout root"}
        if not asset_path.exists():
            return self._needs_wizard(origin, f"Expected artifact path was not found: {asset_path}")

        self.path = str(asset_path)
        if project is not None and getattr(project, "id", None):
            self.project_id = project.id
        metadata = dict(self.metadata or {})
        metadata["git_origin"] = origin.model_dump(mode="json")
        self.metadata = metadata
        await self.save()
        await _index_checkout(checkout_root, project_id=getattr(project, "id", None))
        return {
            "kind": "ready",
            "artifact": self.model_dump(mode="json"),
            "project": project.model_dump(mode="json") if project is not None else None,
            "localPath": str(asset_path),
        }

    @action.post(action_name="resolve-git-location")
    async def resolve_git_location(self):
        """Resolve a git-backed artifact to a local checkout, or request a wizard.

        Body accepts ``current_project_id`` and, after a wizard completes,
        ``local_path``/``project_id``. The action never clones by itself: it
        uses a wizard-provided checkout, an already-valid artifact path, the
        current matching project, or a known local repo. Every filesystem path
        is validated against ``git_origin`` before it can become ready.
        """
        from flow_sdk.builtin.project import Project
        from flow_sdk.request_context.methods import get_current_request_info
        from flow_sdk.responses.response import ApiSuccessResponse
        from flow_sdk.utils.git import find_local_repo_for_url, find_project_root

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        body = body if isinstance(body, dict) else {}

        if self.git_origin is None:
            origin = _artifact_git_origin(self.model_dump(mode="python"))
            if origin is not None:
                self.git_origin = origin
        origin = self.git_origin
        if origin is None:
            return ApiSuccessResponse(data={"kind": "error", "message": "Artifact has no git_origin"})
        if not is_safe_rel_path(origin.rel_path):
            return ApiSuccessResponse(data={"kind": "error", "message": "Artifact git_origin has an unsafe rel_path"})

        async def _ready_from_candidate(
            raw_path: str | None,
            project_id: str | None = None,
            *,
            strict: bool = False,
        ) -> dict | None:
            if not raw_path:
                return None
            try:
                candidate = Path(os.path.expanduser(str(raw_path))).resolve()
            except Exception as e:
                if strict:
                    return self._needs_wizard(origin, f"Could not resolve local path: {e}")
                return None
            if not candidate.exists():
                if strict:
                    return self._needs_wizard(origin, f"Local path does not exist: {candidate}")
                return None
            repo_root = find_project_root(str(candidate))
            if not repo_root:
                if strict:
                    return self._needs_wizard(origin, f"Local path is not inside a git repository: {candidate}")
                return None
            matches, reason = origin.matches_repo(repo_root, require_branch=True)
            if not matches:
                if strict:
                    return self._needs_wizard(origin, reason or "Repository origin does not match")
                return None
            project = await Project.get_by_id(project_id) if project_id else None
            if project is None:
                project = await Project.recover_by_path(repo_root)
            return await self._ready_from_checkout(Path(repo_root), project)

        wizard_result = body.get("wizard_result") if isinstance(body.get("wizard_result"), dict) else {}
        wizard_path = body.get("local_path") or body.get("localPath") or wizard_result.get("localPath")
        wizard_project_id = str(
            body.get("project_id")
            or body.get("projectId")
            or wizard_result.get("projectId")
            or ""
        ).strip() or None
        explicit = await _ready_from_candidate(str(wizard_path) if wizard_path else None, wizard_project_id, strict=True)
        if explicit is not None:
            return ApiSuccessResponse(data=explicit)

        cached = await _ready_from_candidate(self.path, getattr(self, "project_id", None), strict=False)
        if cached is not None:
            return ApiSuccessResponse(data=cached)

        current_project_id = str(body.get("current_project_id") or getattr(self, "project_id", "") or "").strip()
        if current_project_id:
            project = await Project.get_by_id(current_project_id)
            project_root = Path(project.fs_storage_mount_path).expanduser() if project and project.fs_storage_mount_path else None
            repo_root = find_project_root(str(project_root)) if project_root else None
            if repo_root:
                matches, reason = origin.matches_repo(repo_root, require_branch=True)
                if matches:
                    return ApiSuccessResponse(data=await self._ready_from_checkout(Path(repo_root), project))
                if reason and "branch" in reason.lower():
                    return ApiSuccessResponse(data=self._needs_wizard(origin, reason))

        local_repo = find_local_repo_for_url(origin.clone_url())
        if local_repo:
            matches, reason = origin.matches_repo(local_repo, require_branch=True)
            if matches:
                project = await Project.recover_by_path(local_repo)
                return ApiSuccessResponse(data=await self._ready_from_checkout(Path(local_repo), project))
            return ApiSuccessResponse(
                data=self._needs_wizard(origin, reason or "Local repository is not on the expected branch")
            )

        return ApiSuccessResponse(
            data=self._needs_wizard(origin, "No local checkout was found for this git origin")
        )


class ArtifactRelation(Entity):
    """Relationship between two artifacts."""

    type: str = APIField(default="artifact_relation")
    source_artifact_id: str = APIField(description="ID of the source artifact")
    target_artifact_id: str = APIField(description="ID of the target artifact")
    relation_type: ArtifactRelationType = APIField(description="Type of relationship")
    metadata: Dict[str, Any] = APIField(default_factory=dict, description="Additional metadata")

    def __init__(self, **data):
        # Generate ID if not provided
        if "id" not in data:
            data["id"] = str(uuid4())
        super().__init__(**data)

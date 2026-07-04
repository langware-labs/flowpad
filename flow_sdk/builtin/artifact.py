import logging
"""Artifact entity representing filesystem entities or references created during execution."""

from enum import Enum
from typing import Any, ClassVar, Dict, List, Optional
from uuid import uuid4

from pydantic import BaseModel

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


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

    # Service control attributes (for app_service and webapp types)
    port: Optional[str] = APIField(default=None, description="Port number for services")
    start_cmd: Optional[str] = APIField(default=None, description="Command to start/restart the service")
    health: Optional[str] = APIField(default=None, description="Health check endpoint path")

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
        super().__init__(**data)


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

import logging
from datetime import datetime

from pydantic_graph import GraphRunContext

from flow_sdk.flowpad_types.enums import TraceLevel, TraceType
from flow_sdk.builtin.artifact import Artifact, ArtifactReferenceType, ArtifactType
from flow_sdk.core.flow.models import FlowState
from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.shared import TraceItem


async def artifact_log(ctx: GraphRunContext[FlowState, ComputeSession], artifact_data: dict):
    """Log artifact creation to both callback handler and process state."""
    # 1. Create trace message (callback trace is now handled in flow_tools.py)
    trace_message = f"Created artifact: {artifact_data.get('name', 'Unknown')} ({artifact_data.get('type', 'unknown')}) at {artifact_data.get('path', 'unknown path')}"

    # 2. Log to server logs
    logging.info(trace_message)

    # 3. Create Artifact instance and add to flow state
    try:
        # Map string values to enum types
        artifact_type = ArtifactType(artifact_data.get("type", "file"))
        ref_type = ArtifactReferenceType(artifact_data.get("ref_type", "file"))

        # Create artifact instance
        artifact = Artifact(
            name=artifact_data.get("name", "Unknown"),
            artifact_type=artifact_type,
            ref_type=ref_type,
            path=artifact_data.get("path", ""),
            description=artifact_data.get("description", ""),
            metadata=artifact_data.get("metadata"),
            project_id=ctx.deps.project.id if ctx.deps.project else None,
            generating_flow_id=ctx.deps.flow.id if ctx.deps.flow else None,
        )

        # Add to artifacts list as instance (not dict)
        ctx.state.artifacts.append(artifact)

        # 4. Add to trace_items for UI display
        trace = TraceItem(
            type=TraceType.CHAT,
            level=TraceLevel.INFO,
            message=trace_message,
        )
        ctx.state.trace_items.append(trace)

    except (ValueError, TypeError) as e:
        # Fallback: if enum conversion fails, store as dict for backward compatibility
        logging.warning(f"Failed to create Artifact instance: {e}, storing as dict")
        ctx.state.artifacts.append(artifact_data)

        # Still add to trace for UI display
        trace = TraceItem(
            type=TraceType.CHAT,
            level=TraceLevel.INFO,
            message=trace_message,
        )
        ctx.state.trace_items.append(trace)


async def created(ctx: GraphRunContext[FlowState, ComputeSession], artifact_data: dict):
    """Create and track an artifact."""
    await artifact_log(ctx, artifact_data)


def infer_reference_type(path: str, artifact_type_str: str) -> str:
    """Infer the reference type based on path and artifact type."""
    # Check for glob patterns
    if "*" in path or "?" in path or "[" in path:
        return "glob"

    # Check for URLs or external references
    if path.startswith(("http://", "https://", "ftp://", "git://")):
        return "reference"

    # Check if path ends with / or is a known directory
    if path.endswith("/") or artifact_type_str.upper() in ["APP_SERVICE", "CLOUD_SERVICE", "WEBAPP"]:
        return "folder"

    # Default to file
    return "file"


async def from_xml_result(ctx: GraphRunContext[FlowState, ComputeSession], xml_args: dict[str, str]):
    """Create artifact from flow-result XML - helper function"""
    # Extract artifact information from XML attributes
    path = xml_args.get("path", "")
    name = xml_args.get("name", "")
    artifact_type_str = xml_args.get("type", "file")
    description = xml_args.get("description", "")
    artifact_id = xml_args.get("artifact_id", "")
    ref_type_str = xml_args.get("ref_type", infer_reference_type(path, artifact_type_str))

    # Extract service control attributes (for app_service and webapp types)
    start_cmd = xml_args.get("start-cmd", xml_args.get("start_cmd", ""))
    health = xml_args.get("health", "")
    port = xml_args.get("port", "")

    # Use path filename as name if name not provided (backward compatibility)
    if not name and path:
        import os

        name = os.path.basename(path)

    # Create artifact data dictionary
    artifact_data = {
        "artifact_id": artifact_id,
        "name": name,
        "type": artifact_type_str,
        "ref_type": ref_type_str,
        "path": path,
        "description": description,
        "created_at": datetime.now().isoformat(),
    }

    # Add service control metadata for services
    if start_cmd or health or port:
        artifact_data["metadata"] = {
            "start_cmd": start_cmd,
            "health": health,
            "port": port,
        }

    # Track the artifact using the main function
    await created(ctx, artifact_data)

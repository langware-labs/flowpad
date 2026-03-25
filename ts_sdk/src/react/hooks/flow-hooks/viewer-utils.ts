import { Artifact, ArtifactType, CodebaseReferenceType, ViewType } from '@sdk';
import { ViewContext } from '../../types/ViewContext';

/**
 * Resolve which viewer to use based on the ViewContext
 * Simple priority-based resolution:
 * 1. If viewerError is set → UNSUPPORTED
 * 2. If explicit viewerType requested → use it
 * 3. Auto-detect based on codeRef or entity type
 * 4. Fallback → UNSUPPORTED
 */
export function resolveViewer(context: ViewContext): ViewType {
  // 1. If viewerError is set, return UNSUPPORTED
  if (context.viewerError) {
    return ViewType.UNSUPPORTED;
  }

  // 2. If explicit viewerType requested, use it
  if (context.viewerType) {
    return context.viewerType;
  }

  // 3. Auto-detect based on context
  if (context.codeRef) {
    const fileType = context.codeRef.fileType;

    // Markdown files
    if (fileType === 'md') {
      return ViewType.MARKDOWN;
    }

    // Any other file type
    if (fileType) {
      return ViewType.EDITOR;
    }

    // Non-file references
    if (context.codeRef.ref_type === CodebaseReferenceType.REFERENCE) {
      return ViewType.WEB_APP;
    }

    // Folders and globs
    if (
      context.codeRef.ref_type === CodebaseReferenceType.FOLDER ||
      context.codeRef.ref_type === CodebaseReferenceType.GLOB
    ) {
      return ViewType.EDITOR; // Show in code editor
    }

    return ViewType.EDITOR; // Default for code refs
  }

  if (context.entity) {
    // Artifact entities
    if (context.entity instanceof Artifact) {
      if (context.entity.artifact_type === ArtifactType.WEBPAGE) {
        return ViewType.WEB_APP;
      }
      // Most artifacts open in editor
      return ViewType.EDITOR;
    }

    // Other entities - could add more specific handling here
    // For now, default to unsupported
  }

  // 4. Fallback
  return ViewType.UNSUPPORTED;
}

import { InstructionElement, ProcessorStatus } from '@sdk';
import { useCallback, useEffect, useRef } from 'react';
import { AMDEditorProvider, useAMDEditor } from './AMDEditorContext';
import { AMDEditorInner } from './AMDEditorInner';

interface AMDEditorProps {
  /** Initial content to load (read-only after mount, use for initial file load) */
  initialContent: string;
  /** Called when content should be saved (on auto-save or explicit save) */
  onSave?: (content: string) => void;
  /** Auto-save interval in milliseconds (default: 5000ms, set to 0 to disable) */
  autoSaveInterval?: number;
  /** Hide the header and toolbar (session mode) */
  hideHeader?: boolean;
  /** Optional process state for live execution tracking */
  processState?: { status: ProcessorStatus } | null;
  /** Set of completed instruction IDs for status display */
  completedInstructions?: Set<string>;
  /** Called when a new element is added via the editor UI */
  onElementAdded?: (element: InstructionElement) => void;
  /** Called when dirty state changes (true = has unsaved changes) */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Whether the work queue panel is collapsed */
  isCollapsed?: boolean;
  /** Called to toggle collapse/expand of the work queue panel */
  onToggleCollapse?: () => void;
}

/**
 * Inner component that handles auto-save logic.
 * Must be inside AMDEditorProvider to access context.
 */
function AMDEditorWithAutoSave({
  initialContent,
  onSave,
  autoSaveInterval = 5000,
  hideHeader = false,
  onDirtyChange,
  isCollapsed = false,
  onToggleCollapse,
}: {
  initialContent: string;
  onSave?: (content: string) => void;
  autoSaveInterval?: number;
  hideHeader?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { isDirty, serializeToContent, markClean } = useAMDEditor();

  // Notify parent when dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedContentRef = useRef<string>('');

  // Perform save action
  const performSave = useCallback(() => {
    if (!onSave || !isDirty) return;

    const content = serializeToContent();

    // Skip if content hasn't changed since last save
    if (content === lastSavedContentRef.current) {
      return;
    }

    lastSavedContentRef.current = content;
    onSave(content);
    markClean();
  }, [onSave, isDirty, serializeToContent, markClean]);

  // Set up auto-save interval
  useEffect(() => {
    if (!autoSaveInterval || autoSaveInterval <= 0 || !onSave) {
      return;
    }

    autoSaveTimerRef.current = setInterval(() => {
      performSave();
    }, autoSaveInterval);

    return () => {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [autoSaveInterval, onSave, performSave]);

  // Save on unmount if dirty
  useEffect(() => {
    return () => {
      if (isDirty && onSave) {
        const content = serializeToContent();
        if (content !== lastSavedContentRef.current) {
          onSave(content);
        }
      }
    };
  }, [isDirty, onSave, serializeToContent]);

  return (
    <AMDEditorInner
      initialContent={initialContent}
      hideHeader={hideHeader}
      isCollapsed={isCollapsed}
      onToggleCollapse={onToggleCollapse}
    />
  );
}

export function AMDEditor({
  initialContent,
  onSave,
  autoSaveInterval = 5000,
  hideHeader = false,
  processState,
  completedInstructions,
  onElementAdded,
  onDirtyChange,
  isCollapsed = false,
  onToggleCollapse,
}: AMDEditorProps) {
  return (
    <AMDEditorProvider
      processState={processState}
      completedInstructions={completedInstructions}
      onElementAdded={onElementAdded}
    >
      <AMDEditorWithAutoSave
        initialContent={initialContent}
        onSave={onSave}
        autoSaveInterval={autoSaveInterval}
        hideHeader={hideHeader}
        onDirtyChange={onDirtyChange}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
      />
    </AMDEditorProvider>
  );
}

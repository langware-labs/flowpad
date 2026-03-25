import {
  genInstructionId,
  InstructionElement,
  InstructionElementParser,
  InstructionElementType,
  ProcessState,
  ProcessorStatus,
  SkillParser,
} from '@sdk';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AMDElement, isContainerType } from './types';

/**
 * Execution status for an instruction block
 */
export type InstructionStatus = 'idle' | 'executing' | 'completed' | 'error';

/**
 * Metadata extracted from YAML frontmatter
 */
export interface AMDMetadata {
  name?: string;
  description?: string;
}

interface AMDEditorContextValue {
  /** All root-level elements */
  elements: AMDElement[];
  /** Metadata from YAML frontmatter */
  metadata: AMDMetadata;
  /** Whether content has been modified since last load/save */
  isDirty: boolean;
  /** Currently selected element ID */
  selectedId: string | null;
  /** Set of expanded container element IDs */
  expandedIds: Set<string>;
  /** Whether to show completed instructions (false = hide them) */
  showCompleted: boolean;

  // Load/Save (explicit, not reactive)
  /** Load content from AMD string - call once on mount */
  loadFromContent: (content: string) => void;
  /** Serialize elements back to AMD string - call on save */
  serializeToContent: () => string;
  /** Mark as clean (after save) */
  markClean: () => void;

  /** Select an element */
  selectElement: (id: string | null) => void;
  /** Toggle expansion of a container element */
  toggleExpanded: (id: string) => void;
  /** Add a new element */
  addElement: (type: InstructionElementType, parentId?: string, afterId?: string) => void;
  /** Update an element's attributes or content */
  updateElement: (
    id: string,
    updates: Partial<{ content: string; attributes: Record<string, string>; title: string | null }>,
  ) => void;
  /** Delete an element */
  deleteElement: (id: string) => void;
  /** Move an element up or down */
  moveElement: (id: string, direction: 'up' | 'down') => void;
  /** Toggle showing/hiding completed instructions */
  setShowCompleted: (show: boolean) => void;

  /** Process state for execution tracking */
  processState: ProcessState | null;
  /** Get execution status for an instruction by its ID */
  getInstructionStatus: (instructionId: string) => InstructionStatus;
}

const AMDEditorContext = createContext<AMDEditorContextValue | null>(null);

interface AMDEditorProviderProps {
  children: React.ReactNode;
  /** Optional process state for execution tracking */
  processState?: ProcessState | null;
  /** Set of completed instruction IDs */
  completedInstructions?: Set<string>;
  /** Called when a new element is added via addElement */
  onElementAdded?: (element: InstructionElement) => void;
}

/**
 * Generate a unique local ID for React reconciliation
 */
function generateLocalId(): string {
  return `amd-${genInstructionId()}`;
}

/**
 * Build a map of instruction ID → localId from existing elements (recursive).
 * Used by the parser to preserve localIds when re-parsing content.
 */
export function buildIdMap(elements: AMDElement[], map: Map<string, string> = new Map()): Map<string, string> {
  for (const el of elements) {
    const instructionId = el.element.attributes.id;
    if (instructionId) {
      map.set(instructionId, el.localId);
    }
    buildIdMap(el.children, map);
  }
  return map;
}

/**
 * Create an AMDElement wrapper around an InstructionElement
 */
export function wrapElement(element: InstructionElement): AMDElement {
  return {
    localId: generateLocalId(),
    element,
    children: element.children.map((child) => wrapElement(child)),
  };
}

/**
 * Create an AMDElement wrapper, reusing localId from existing elements when possible.
 * This prevents focus loss when re-parsing content by keeping React keys stable.
 */
export function wrapElementPreservingIds(element: InstructionElement, existingIdMap: Map<string, string>): AMDElement {
  const instructionId = element.attributes.id;
  const existingLocalId = instructionId ? existingIdMap.get(instructionId) : undefined;

  return {
    localId: existingLocalId || generateLocalId(),
    element,
    children: element.children.map((child) => wrapElementPreservingIds(child, existingIdMap)),
  };
}

/**
 * Find an element by ID in the tree
 */
function findElementById(elements: AMDElement[], id: string): AMDElement | null {
  for (const el of elements) {
    if (el.localId === id) {
      return el;
    }
    const found = findElementById(el.children, id);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Find parent array and index of an element
 */
function findElementLocation(
  elements: AMDElement[],
  id: string,
  parent: AMDElement | null = null,
): { array: AMDElement[]; index: number; parent: AMDElement | null } | null {
  for (let i = 0; i < elements.length; i++) {
    if (elements[i].localId === id) {
      return { array: elements, index: i, parent };
    }
    const found = findElementLocation(elements[i].children, id, elements[i]);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Strip YAML frontmatter from content and return body only.
 */
function stripYAMLFrontmatter(content: string): string {
  try {
    const { content: body } = SkillParser.parse(content);
    return body;
  } catch {
    // If SKILL parsing fails, check for manual frontmatter
    const lines = content.split('\n');
    if (lines[0]?.trim() === '---') {
      const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
      if (endIndex > 0) {
        return lines
          .slice(endIndex + 1)
          .join('\n')
          .trim();
      }
    }
    return content;
  }
}

/**
 * Extract metadata from YAML frontmatter.
 */
function extractMetadata(content: string): AMDMetadata {
  try {
    const { metadata } = SkillParser.parse(content);
    return {
      name: metadata?.name,
      description: metadata?.description,
    };
  } catch {
    return {};
  }
}

/**
 * Serialize elements to AMD string format.
 */
function serializeElementsToString(elements: AMDElement[]): string {
  const parts: string[] = [];

  for (const amdEl of elements) {
    const serialized = amdEl.element.toAmdString();
    if (serialized) {
      parts.push(serialized);
    }
  }

  return parts.join('\n\n');
}

/**
 * Build YAML frontmatter string from metadata.
 */
function buildFrontmatter(metadata: AMDMetadata): string {
  if (!metadata.name && !metadata.description) {
    return '';
  }

  const lines = ['---'];
  if (metadata.name) {
    lines.push(`name: ${metadata.name}`);
  }
  if (metadata.description) {
    lines.push(`description: ${metadata.description}`);
  }
  lines.push('---', '');

  return lines.join('\n');
}

export function AMDEditorProvider({
  children,
  processState = null,
  completedInstructions = new Set(),
  onElementAdded,
}: AMDEditorProviderProps) {
  const [elements, setElements] = useState<AMDElement[]>([]);
  const [metadata, setMetadata] = useState<AMDMetadata>({});
  const [isDirty, setIsDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showCompleted, setShowCompleted] = useState(true);

  // Parser instance (reused)
  const parserRef = useRef(new InstructionElementParser());

  /**
   * Load content from AMD string - explicit action, not reactive.
   * Call this once on mount or when loading a new file.
   */
  const loadFromContent = useCallback((content: string) => {
    try {
      // Extract metadata from frontmatter
      const extractedMetadata = extractMetadata(content);
      setMetadata(extractedMetadata);

      // Strip frontmatter and parse body
      const bodyContent = stripYAMLFrontmatter(content);
      const parsedElements = parserRef.current.parse(bodyContent);

      // Wrap with local IDs for React keys
      const wrappedElements = parsedElements.map(wrapElement);
      setElements(wrappedElements);

      // Reset dirty flag after loading
      setIsDirty(false);
    } catch (error) {
      console.error('[AMDEditorContext] Parse error:', error);
      setElements([]);
      setMetadata({});
      setIsDirty(false);
    }
  }, []);

  /**
   * Serialize elements back to AMD string - explicit action for saving.
   * Includes YAML frontmatter if metadata exists.
   */
  const serializeToContent = useCallback((): string => {
    const frontmatter = buildFrontmatter(metadata);
    const body = serializeElementsToString(elements);

    if (frontmatter) {
      return frontmatter + '\n' + body;
    }
    return body;
  }, [elements, metadata]);

  /**
   * Mark content as clean (after successful save).
   */
  const markClean = useCallback(() => {
    setIsDirty(false);
  }, []);

  /**
   * Get execution status for an instruction by its ID
   */
  const getInstructionStatus = useCallback(
    (instructionId: string): InstructionStatus => {
      if (!processState || !instructionId) {
        return 'idle';
      }

      // Check if there was an error on this instruction
      if (processState.status === ProcessorStatus.ERROR && processState.error) {
        // Check if current instruction matches (via currentInstructionId or stack)
        if (processState.currentInstructionId === instructionId) {
          return 'error';
        }
        const currentInStack = processState.stack.find((frame) => frame.instructionId === instructionId);
        if (currentInStack) {
          return 'error';
        }
      }

      // Check if this instruction is currently executing via currentInstructionId (for top-level flow-do)
      if (
        processState.currentInstructionId === instructionId &&
        (processState.status === ProcessorStatus.RUNNING || processState.status === ProcessorStatus.STEPPING)
      ) {
        return 'executing';
      }

      // Check if this instruction is currently executing (in the stack) for nested instructions
      const isInStack = processState.stack.some((frame) => frame.instructionId === instructionId);
      if (
        isInStack &&
        (processState.status === ProcessorStatus.RUNNING || processState.status === ProcessorStatus.STEPPING)
      ) {
        return 'executing';
      }

      // Check if this instruction has completed
      if (completedInstructions.has(instructionId)) {
        return 'completed';
      }

      return 'idle';
    },
    [processState, completedInstructions],
  );

  const selectElement = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const addElement = useCallback(
    (type: InstructionElementType, parentId?: string, afterId?: string) => {
      const isSelfClosing = !isContainerType(type);
      const newElement = new InstructionElement(
        type,
        type === 'do' ? { id: genInstructionId() } : {},
        '',
        isSelfClosing,
        0,
        null,
        type === 'text', // markless for text blocks
      );

      const wrapped = wrapElement(newElement);

      setElements((prev) => {
        const newElements = [...prev];

        if (parentId) {
          // Add as child of parent
          const parent = findElementById(newElements, parentId);
          if (parent && isContainerType(parent.element.elementType)) {
            if (afterId) {
              const afterIndex = parent.children.findIndex((c) => c.localId === afterId);
              if (afterIndex >= 0) {
                parent.children.splice(afterIndex + 1, 0, wrapped);
              } else {
                parent.children.push(wrapped);
              }
            } else {
              parent.children.push(wrapped);
            }
            parent.element.children.push(newElement);
            // Auto-expand the parent
            setExpandedIds((prev) => new Set([...prev, parentId]));
          }
        } else if (afterId) {
          // Insert after specific element at root level
          const location = findElementLocation(newElements, afterId);
          if (location && location.parent === null) {
            newElements.splice(location.index + 1, 0, wrapped);
          } else {
            newElements.push(wrapped);
          }
        } else {
          // Add to root
          newElements.push(wrapped);
        }

        return newElements;
      });

      // Select the new element
      setSelectedId(wrapped.localId);
      setIsDirty(true);

      // Notify parent about the new element
      onElementAdded?.(newElement);
    },
    [onElementAdded],
  );

  const updateElement = useCallback(
    (id: string, updates: Partial<{ content: string; attributes: Record<string, string>; title: string | null }>) => {
      setElements((prev) => {
        const newElements = [...prev];
        const element = findElementById(newElements, id);
        if (element) {
          if (updates.content !== undefined) {
            element.element.content = updates.content;
          }
          if (updates.attributes !== undefined) {
            Object.assign(element.element.attributes, updates.attributes);
          }
          if (updates.title !== undefined) {
            element.element.title = updates.title;
          }
        }
        return newElements;
      });
      setIsDirty(true);
    },
    [],
  );

  const deleteElement = useCallback(
    (id: string) => {
      setElements((prev) => {
        const newElements = [...prev];
        const location = findElementLocation(newElements, id);
        if (location) {
          location.array.splice(location.index, 1);
          // Also remove from parent's element.children if nested
          if (location.parent) {
            const childIndex = location.parent.element.children.findIndex(
              (c) => c === location.array[location.index]?.element,
            );
            if (childIndex >= 0) {
              location.parent.element.children.splice(childIndex, 1);
            }
          }
        }
        return newElements;
      });

      // Clear selection if deleted element was selected
      if (selectedId === id) {
        setSelectedId(null);
      }
      setIsDirty(true);
    },
    [selectedId],
  );

  const moveElement = useCallback((id: string, direction: 'up' | 'down') => {
    setElements((prev) => {
      const newElements = [...prev];
      const location = findElementLocation(newElements, id);
      if (!location) return prev;

      const { array, index } = location;
      const newIndex = direction === 'up' ? index - 1 : index + 1;

      if (newIndex < 0 || newIndex >= array.length) {
        return prev; // Can't move beyond bounds
      }

      // Swap elements
      [array[index], array[newIndex]] = [array[newIndex], array[index]];

      // Also update parent's element.children if nested
      if (location.parent) {
        const parentChildren = location.parent.element.children;
        [parentChildren[index], parentChildren[newIndex]] = [parentChildren[newIndex], parentChildren[index]];
      }

      return newElements;
    });
    setIsDirty(true);
  }, []);

  const value = useMemo(
    () => ({
      elements,
      metadata,
      isDirty,
      selectedId,
      expandedIds,
      showCompleted,
      loadFromContent,
      serializeToContent,
      markClean,
      selectElement,
      toggleExpanded,
      addElement,
      updateElement,
      deleteElement,
      moveElement,
      setShowCompleted,
      processState,
      getInstructionStatus,
    }),
    [
      elements,
      metadata,
      isDirty,
      selectedId,
      expandedIds,
      showCompleted,
      loadFromContent,
      serializeToContent,
      markClean,
      selectElement,
      toggleExpanded,
      addElement,
      updateElement,
      deleteElement,
      moveElement,
      processState,
      getInstructionStatus,
    ],
  );

  return <AMDEditorContext.Provider value={value}>{children}</AMDEditorContext.Provider>;
}

export function useAMDEditor(): AMDEditorContextValue {
  const context = useContext(AMDEditorContext);
  if (!context) {
    throw new Error('useAMDEditor must be used within an AMDEditorProvider');
  }
  return context;
}

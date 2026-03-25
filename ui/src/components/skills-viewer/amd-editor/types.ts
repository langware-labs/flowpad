import { InstructionElement, InstructionElementType } from '@sdk';

/**
 * Extended element interface with local ID for React keys
 */
export interface AMDElement {
  /** Unique local ID for React reconciliation */
  localId: string;
  /** The underlying SDK instruction element */
  element: InstructionElement;
  /** Child elements (mirrors element.children but with AMDElement wrapper) */
  children: AMDElement[];
}

/**
 * Block type configuration
 */
export interface BlockConfig {
  type: InstructionElementType;
  label: string;
  color: string;
  icon?: string;
  isContainer: boolean;
  description: string;
}

/**
 * Block configurations by type
 */
export const BLOCK_CONFIGS: Record<InstructionElementType, BlockConfig> = {
  do: {
    type: 'do',
    label: 'Do',
    color: 'border-blue-500',
    isContainer: false,
    description: 'Execute instructions',
  },
  if: {
    type: 'if',
    label: 'If',
    color: 'border-orange-500',
    isContainer: true,
    description: 'Conditional execution',
  },
  each: {
    type: 'each',
    label: 'Each',
    color: 'border-green-500',
    isContainer: true,
    description: 'Loop over items',
  },
  set: {
    type: 'set',
    label: 'Set',
    color: 'border-purple-500',
    isContainer: false,
    description: 'Store a value',
  },
  ui: {
    type: 'ui',
    label: 'UI',
    color: 'border-cyan-500',
    isContainer: false,
    description: 'Show UI component',
  },
  block: {
    type: 'block',
    label: 'Block',
    color: 'border-gray-500',
    isContainer: true,
    description: 'Group instructions',
  },
  call: {
    type: 'call',
    label: 'Call',
    color: 'border-teal-500',
    isContainer: false,
    description: 'Call another file',
  },
  text: {
    type: 'text',
    label: 'Text',
    color: 'border-slate-300',
    isContainer: false,
    description: 'Plain text content',
  },
  header: {
    type: 'header',
    label: 'Header',
    color: 'border-slate-400',
    isContainer: false,
    description: 'File metadata',
  },
  tag: {
    type: 'tag',
    label: 'Tag',
    color: 'border-zinc-400',
    isContainer: false,
    description: 'Custom tag element',
  },
};

/**
 * Container types that can have nested children
 */
export const CONTAINER_TYPES: InstructionElementType[] = ['if', 'each', 'block'];

/**
 * Check if an element type is a container
 */
export function isContainerType(type: InstructionElementType): boolean {
  return CONTAINER_TYPES.includes(type);
}

/**
 * Block types available for user creation (excludes header)
 */
export const CREATABLE_BLOCK_TYPES: InstructionElementType[] = ['do', 'if', 'each', 'set', 'ui', 'block', 'call'];

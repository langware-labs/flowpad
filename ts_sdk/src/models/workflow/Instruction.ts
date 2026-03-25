import { InstructionStatus } from './InstructionStatus';

/**
 * Instruction represents a single executable step in a workflow.
 * Supports hierarchical execution with nested flow-calls.
 */
export class Instruction {
  id: string;
  lineNumber: number;
  content: string;
  status: InstructionStatus;
  error?: string;
  timestamp?: Date;

  // Hierarchical execution fields
  /** Instruction type: 'do' for standard, 'call' for scoped execution (flow-call, skill, task) */
  type: 'do' | 'call' = 'do';
  /** Path to called file/skill (for call instructions) */
  href?: string;
  /** Child instructions (populated dynamically for flow-call) */
  children: Instruction[] = [];
  /** Parent instruction ID (null for root-level instructions) */
  parentId: string | null = null;
  /** Nesting depth (0 for root, 1 for first-level nested, etc.) */
  depth: number = 0;
  /** UI expansion state for collapsible tree view */
  expanded: boolean = true;
  /** Child progress tracking for flow-call instructions */
  childProgress?: {
    total: number;
    completed: number;
    failed: number;
  };

  constructor(lineNumber: number, content: string, status: InstructionStatus = InstructionStatus.PENDING, id?: string) {
    this.id = id || `inst_${lineNumber}`;
    this.lineNumber = lineNumber;
    this.content = content;
    this.status = status;
  }
}

/**
 * Parse instruction ID to extract depth and parent ID.
 * E.g., "inst_2.3.1" -> { depth: 2, parentId: "inst_2.3" }
 */
export function parseInstructionId(id: string): { depth: number; parentId: string | null } {
  const parts = id.split('.');
  return {
    depth: parts.length - 1,
    parentId: parts.length > 1 ? parts.slice(0, -1).join('.') : null,
  };
}

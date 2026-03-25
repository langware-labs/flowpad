import { Instruction } from './Instruction';
import { WorkflowStatus } from './InstructionStatus';

/**
 * Execution context for flow instruction execution.
 * Supports tree-structured instructions with scope tracking.
 */
export interface InstructionExecutionContext {
  /** Path to the root instruction file */
  filePath: string;
  /** Root-level instructions (tree structure) */
  rootInstructions: Instruction[];
  /** Flat index for O(1) lookup by instruction ID */
  flatIndex: Map<string, Instruction>;
  /** Stack of active scope instruction IDs (for nested flow-call tracking) */
  activeScopes: string[];
  /** Currently executing instruction ID */
  currentInstructionId: string | null;
  /** Overall workflow status */
  status: WorkflowStatus;
  /** Execution start time */
  startedAt?: Date;
  /** Execution completion time */
  completedAt?: Date;
  /** Weighted progress (each flow-call counts as 1 step) */
  progress: {
    total: number;
    completed: number;
    failed: number;
  };
}

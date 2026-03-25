import { InstructionStatus, WorkflowStatus } from '@sdk';
import type { InstructionExecutionContext } from '../types';
import { Instruction } from '../types';

export function countStatuses(instructions: Instruction[]): {
  completed: number;
  failed: number;
  pending: number;
  allDone: boolean;
} {
  let completed = 0;
  let failed = 0;
  let pending = 0;

  for (const inst of instructions) {
    if (inst.status === InstructionStatus.COMPLETED) {
      completed++;
    } else if (inst.status === InstructionStatus.FAILED) {
      failed++;
    } else if (inst.status === InstructionStatus.PENDING) {
      pending++;
    }
  }

  const allDone = pending === 0 && instructions.every((i) => i.status !== InstructionStatus.EXECUTING);
  return { completed, failed, pending, allDone };
}

export function withUpdatedProgress(
  prev: InstructionExecutionContext,
  updates: Partial<InstructionExecutionContext> = {},
): InstructionExecutionContext {
  const { completed, failed, allDone } = countStatuses(prev.rootInstructions);
  return {
    ...prev,
    ...updates,
    status: allDone ? (failed > 0 ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED) : prev.status,
    completedAt: allDone ? new Date() : prev.completedAt,
    progress: { total: prev.progress.total, completed, failed },
  };
}

export function createFlatIndex(
  instructions: Instruction[],
  index: Map<string, Instruction> = new Map(),
): Map<string, Instruction> {
  for (const inst of instructions) {
    index.set(inst.id, inst);
    if (inst.children.length > 0) {
      createFlatIndex(inst.children, index);
    }
  }
  return index;
}

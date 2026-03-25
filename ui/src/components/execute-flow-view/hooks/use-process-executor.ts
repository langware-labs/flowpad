import { normalizeVfsPathToLocal } from '@src/hooks/use-fs-item-flows';
import {
  Agent,
  connectionManager,
  ContextEntitiesEnum,
  dataContext,
  InstructionStatus,
  Project,
  TypeId,
  WorkflowStatus,
} from '@sdk';
import { useProcess, useProcessActions } from '@sdk/react/hooks';
import { useCallback, useState } from 'react';
import type { InstructionExecutionContext } from '../types';
import { Instruction } from '../types';
import { createFlatIndex, withUpdatedProgress } from './context-utils';

export function useProcessExecutor(agent: Agent | null | undefined, project: Project | null | undefined) {
  const [context, setContext] = useState<InstructionExecutionContext | null>(null);
  const { data: flow } = useProcess();
  const { send, cancel } = useProcessActions(flow ?? null);

  const detectFlowCallsInInstructions = useCallback((instructions: Instruction[]) => {
    for (const inst of instructions) {
      // Detect scoped instructions: .md files (flow-call, skill), Task/subagent, or skill references
      const mdMatches = [...inst.content.matchAll(/["']?([^"'\s]+\.md)["']?/g)].map((m) => m[1]);
      const isTask = /\bTask\s*\(|spawn\s+(a\s+)?subagent|subagent_type/i.test(inst.content);
      const isSkillRef = /\b(use|follow|read.*follow)\s+\w+\s+skill\b/i.test(inst.content);

      if (isTask || isSkillRef) {
        inst.type = 'call';
      } else if (mdMatches.length === 1) {
        // Only set href for simple single-file references
        inst.type = 'call';
        inst.href = mdMatches[0];
      }
    }
  }, []);

  const loadFile = useCallback(
    (filePath: string, instructions: Instruction[], detectFlowCalls: boolean = true) => {
      void dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, null);

      if (detectFlowCalls) {
        detectFlowCallsInInstructions(instructions);
      }

      setContext({
        filePath,
        rootInstructions: instructions,
        flatIndex: createFlatIndex(instructions),
        activeScopes: [],
        currentInstructionId: null,
        status: WorkflowStatus.IDLE,
        progress: { total: instructions.length, completed: 0, failed: 0 },
      });
    },
    [detectFlowCallsInInstructions],
  );

  const startExecution = useCallback(async () => {
    if (!agent || !project || !context) {
      console.error('[ExecuteFlow] agent, project, or context not available');
      return;
    }

    const { filePath, rootInstructions } = context;

    await connectionManager.connect();

    const normalizedFilePath = normalizeVfsPathToLocal(filePath) || filePath;
    const agentId = agent.id;
    let flowTypeId: TypeId;

    try {
      flowTypeId = await project.createFlow(agentId, normalizedFilePath);
    } catch (error) {
      console.error('[ExecuteFlow] Failed to create flow:', error);
      setContext((prev) => (prev ? { ...prev, status: WorkflowStatus.FAILED } : null));
      return;
    }

    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, flowTypeId);

    // Reset all instruction properties for a clean execution state
    const updatedInstructions = rootInstructions.map((inst, idx) => ({
      ...inst,
      status: idx === 0 ? InstructionStatus.EXECUTING : InstructionStatus.PENDING,
      error: undefined,
      traceOutput: undefined,
      children: [],
      childProgress: undefined,
      expanded: false,
    }));

    setContext((prev) =>
      prev
        ? {
            ...prev,
            rootInstructions: updatedInstructions,
            flatIndex: createFlatIndex(updatedInstructions),
            activeScopes: [],
            currentInstructionId: updatedInstructions[0]?.id || null,
            status: WorkflowStatus.RUNNING,
            startedAt: new Date(),
            progress: { total: rootInstructions.length, completed: 0, failed: 0 },
          }
        : null,
    );

    try {
      await send(rootInstructions.map((inst) => inst.content).join('\n'));
    } catch (error) {
      console.error('[ExecuteFlow] Execution failed:', error);
      setContext((prev) => (prev ? { ...prev, status: WorkflowStatus.FAILED } : null));
    }
  }, [agent, project, context, send]);

  const clearContext = useCallback(() => {
    setContext(null);
    void dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, null);
  }, []);

  const stopExecution = useCallback(() => {
    void cancel();
    // Reset to IDLE and reset all instruction statuses to PENDING
    setContext((prev) => {
      if (!prev) return null;
      // Reset all instructions to PENDING
      for (const inst of prev.flatIndex.values()) {
        inst.status = InstructionStatus.PENDING;
        inst.error = undefined;
      }
      return {
        ...prev,
        status: WorkflowStatus.IDLE,
        currentInstructionId: null,
        progress: { total: prev.progress.total, completed: 0, failed: 0 },
      };
    });
  }, [cancel]);

  const skipInstruction = useCallback((instructionId: string) => {
    setContext((prev) => {
      if (!prev) return null;
      const instruction = prev.flatIndex.get(instructionId);
      if (instruction) {
        instruction.status = InstructionStatus.SKIPPED;
      }
      return withUpdatedProgress(prev);
    });
  }, []);

  const retryInstruction = useCallback(
    async (instructionId: string) => {
      if (!context) return;

      const instruction = context.flatIndex.get(instructionId);
      if (!instruction) return;

      setContext((prev) => {
        if (!prev) return null;
        instruction.status = InstructionStatus.EXECUTING;
        instruction.timestamp = new Date();
        instruction.error = undefined;
        return { ...prev, currentInstructionId: instructionId };
      });

      try {
        await send(instruction.content);
        setContext((prev) => {
          if (!prev) return null;
          instruction.status = InstructionStatus.COMPLETED;
          return withUpdatedProgress(prev);
        });
      } catch (error) {
        console.error('[ExecuteFlow] Retry failed:', error);
        setContext((prev) => {
          if (!prev) return null;
          instruction.status = InstructionStatus.FAILED;
          instruction.error = error instanceof Error ? error.message : 'Unknown error';
          return { ...prev };
        });
      }
    },
    [context, send],
  );

  const toggleExpand = useCallback((instructionId: string) => {
    setContext((prev) => {
      if (!prev) return null;
      const instruction = prev.flatIndex.get(instructionId);
      if (instruction) {
        instruction.expanded = !instruction.expanded;
      }
      return { ...prev };
    });
  }, []);

  return {
    context,
    loadFile,
    startExecution,
    stopExecution,
    clearContext,
    skipInstruction,
    retryInstruction,
    toggleExpand,
  };
}

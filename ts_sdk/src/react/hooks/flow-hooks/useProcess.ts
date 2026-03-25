import { CreateFlowOptions, dataContext, Flow, TypeId } from '@sdk';
import { useCallback, useMemo } from 'react';
import { useEntity } from '../entity-hooks';
import { useContext } from '../useContext';

export function useProcess(flowTypeId?: TypeId | null, options?: Parameters<typeof useEntity<Flow>>[1]) {
  const context = useContext();
  const effectiveFlowTypeId = useMemo(() => {
    if (flowTypeId) return flowTypeId;
    return context.flow?.typeId ?? null;
  }, [flowTypeId, context.flow]);

  const createFlow = useCallback((workspaceId?: string, createOptions?: CreateFlowOptions): Flow => {
    return dataContext.createFlow(workspaceId, createOptions);
  }, []);

  const entityResult = useEntity<Flow>(effectiveFlowTypeId, {
    watch: true,
    ...options,
  });

  return { ...entityResult, createFlow };
}

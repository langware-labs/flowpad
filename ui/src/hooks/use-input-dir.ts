import { ActionInfo, TypeId, type AgenticProcess } from '@sdk';
import { useAction } from './use-action';
import { useMemo } from 'react';

interface InputDirInfo {
  absPath: string;
  computeNodeTypeId: TypeId;
}

interface InputDirResponse {
  abs_path: string;
  compute_node_id: string;
}

export function useInputDir(process: AgenticProcess | undefined): InputDirInfo | null {
  const actionInfo = useMemo(() => {
    if (!process?.id) return null;
    return new ActionInfo('input-dir', 'agentic_process', process.id, 'GET');
  }, [process?.id]);

  const { data } = useAction<InputDirResponse>(actionInfo);

  return useMemo(() => {
    if (!data?.abs_path || !data?.compute_node_id) return null;
    try {
      return {
        absPath: data.abs_path,
        computeNodeTypeId: new TypeId(data.compute_node_id),
      };
    } catch {
      return null;
    }
  }, [data?.abs_path, data?.compute_node_id]);
}

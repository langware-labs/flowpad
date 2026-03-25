import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { fetchClaudeContextFromComputeNode, type ClaudeContextData } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

interface UseClaudeContextResult {
  data: ClaudeContextData | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useClaudeContext(sessionId?: string | null): UseClaudeContextResult {
  const { computeNode } = useAgentContext();
  const [data, setData] = useState<ClaudeContextData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    if (!computeNode?.id) return;
    setIsLoading(true);
    const result = await fetchClaudeContextFromComputeNode(computeNode.id, sessionId ?? undefined);
    if (cancelledRef.current) return;
    if (result) setData(result);
    setIsLoading(false);
  }, [computeNode?.id, sessionId]);

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  return { data, isLoading, refetch: load };
}

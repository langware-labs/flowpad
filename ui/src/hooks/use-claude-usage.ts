import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { fetchClaudeUsageFromComputeNode, type ClaudeUsageData } from '@sdk';
import { useEffect, useRef, useState } from 'react';

const cache = new Map<string, { data: ClaudeUsageData; ts: number }>();
const inFlight = new Map<string, Promise<ClaudeUsageData | null>>();
const STALE_MS = 60_000;

interface UseClaudeUsageResult {
  data: ClaudeUsageData | null;
  isLoading: boolean;
}

export function useClaudeUsage(): UseClaudeUsageResult {
  const { computeNode } = useAgentContext();
  const [data, setData] = useState<ClaudeUsageData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!computeNode?.id) return;
    cancelledRef.current = false;

    const load = async () => {
      const cached = cache.get(computeNode.id);
      if (cached && Date.now() - cached.ts < STALE_MS) {
        setData(cached.data);
        return;
      }
      setIsLoading(true);
      let pending = inFlight.get(computeNode.id);
      if (!pending) {
        pending = fetchClaudeUsageFromComputeNode(computeNode.id);
        inFlight.set(computeNode.id, pending);
      }
      const result = await pending;
      inFlight.delete(computeNode.id);
      if (cancelledRef.current) return;
      if (result) {
        cache.set(computeNode.id, { data: result, ts: Date.now() });
        setData(result);
      }
      setIsLoading(false);
    };

    void load();
    const interval = setInterval(() => void load(), STALE_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [computeNode?.id]);

  return { data, isLoading };
}

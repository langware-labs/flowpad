/**
 * The box's funding picture, as one cached read.
 *
 * Everything the page renders — the per-harness source lists, which one wins, the endpoints on
 * offer — comes from a single backend call, because the resolver that answers it is the same one
 * a spawn uses. Deriving "which source wins" in the client would put the resolver in two places
 * and let them disagree, which is exactly the drift a stale `login_state` caused once.
 */
import {
  capabilityManager,
  HARNESS_CAPABILITY_KINDS,
  llmSourcesService,
  type LLMFundingStatus,
  type LLMSourceRef,
} from '@sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const LLM_SOURCES_KEY = ['llm-sources'] as const;

export function useLlmSources() {
  const { data, isLoading } = useQuery({
    queryKey: LLM_SOURCES_KEY,
    queryFn: () => llmSourcesService.status(),
    staleTime: 10_000,
  });
  return { status: (data ?? null) as LLMFundingStatus | null, isLoading };
}

/** Choose which source funds a harness. One write, straight through the SDK — the page never
 *  touches `auth_mode` / `api_provider` itself, so the kind→fields mapping lives in Python. */
export function useSelectSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ harness, source }: { harness: string; source: LLMSourceRef }) =>
      llmSourcesService.select(harness, source),
    onSuccess: (status) => {
      qc.setQueryData(LLM_SOURCES_KEY, status);
      // `select` writes the same `auth_mode` / `api_provider` that `capabilityManager.setAuthMode`
      // does, but server-side — so it bypasses that manager's own invalidation. Everything else
      // that shows a harness's auth mode (the login modal, the footer warnings, the terminal
      // strip) reads `capabilityManager.getSnapshot`, and would keep showing the previous source
      // until something unrelated reloaded it. One write, one cache refresh.
      // Fire-and-forget: awaiting it would hold `isPending` (and every row's button) for an
      // extra round-trip after the write already landed.
      void capabilityManager.load(true);
    },
  });
}

/** Harness kinds in display order, filtered to those the box actually reported. */
export function harnessKinds(status: LLMFundingStatus | null | undefined): string[] {
  const known = new Set(Object.keys(status?.sources ?? {}));
  return HARNESS_CAPABILITY_KINDS.filter((kind) => known.has(kind));
}

/** `harness.claude.cli` → `claude`. */
export function workerOf(kind: string): string {
  return kind.split('.')[1] ?? kind;
}

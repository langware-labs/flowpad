/**
 * The box's funding picture, as one cached read.
 *
 * Everything the page renders — the per-harness source lists, which one wins, the endpoints on
 * offer — comes from a single backend call, because the resolver that answers it is the same one
 * a spawn uses. Deriving "which source wins" in the client would put the resolver in two places
 * and let them disagree, which is exactly the drift a stale `login_state` caused once.
 */
import { HARNESS_CAPABILITY_KINDS, llmSourcesService, type LLMFundingStatus, type LLMSourceRef } from '@sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const LLM_SOURCES_KEY = ['llm-sources'] as const;

export function useLlmSources() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: LLM_SOURCES_KEY,
    queryFn: () => llmSourcesService.status(),
    staleTime: 10_000,
  });
  return { status: data as LLMFundingStatus | undefined, isLoading, error, refetch };
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
    },
  });
}

/** Harness kinds in display order, filtered to those the box actually reported. */
export function harnessKinds(status: LLMFundingStatus | undefined): string[] {
  const known = new Set(Object.keys(status?.sources ?? {}));
  return HARNESS_CAPABILITY_KINDS.filter((kind) => known.has(kind));
}

/** `harness.claude.cli` → `claude`. */
export function workerOf(kind: string): string {
  return kind.split('.')[1] ?? kind;
}

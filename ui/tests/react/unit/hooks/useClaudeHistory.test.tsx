import { ComputeNode, ContextEntitiesEnum, dataContext } from '@sdk';
import { useClaudeHistory } from '@src/hooks/useClaudeHistory';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../../../utils/test-utils';

describe('useClaudeHistory hook (end-to-end)', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);

    // apiTestSetup does bootstrap but doesn't set up the compute node context.
    // Replicate what initSdk/refreshProject does: read the default_compute_node
    // from bootstrap and set it in dataContext.
    const cnData = dataContext.bootstrapInfo?.default_compute_node;
    if (cnData) {
      const cn = new ComputeNode(cnData);
      cn.markAsExpanded();
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentComputeNodeTypeId, cn.typeId);
    }
  }, 15000);

  it('should fetch history entries sorted descending with embedded sessions', async () => {
    expect(dataContext.computeNode).toBeTruthy();

    const { result } = renderHook(() => useClaudeHistory(5));

    // Wait for fetch to complete
    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 10000 },
    );

    const { entries } = result.current;
    expect(Array.isArray(entries)).toBe(true);

    // No history on this machine → nothing else to verify
    if (entries.length === 0) return;

    // --- Entry shape ---
    const first = entries[0];
    expect(typeof first.display).toBe('string');
    expect(typeof first.timestamp_ms).toBe('number');
    expect(first.timestamp_ms).toBeGreaterThan(0);
    expect(first).toHaveProperty('session_id');

    // --- Sort order: newest first ---
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].timestamp_ms).toBeGreaterThanOrEqual(entries[i].timestamp_ms);
    }

    // --- Limit semantics: PER-PROJECT-SCOPE, not a global top-N ---
    // `get_worker_history` (backend) keeps each project's newest `limit` sessions
    // rather than a single global `collected[:limit]`, so an UNSCOPED fetch returns
    // up to `limit` PER project_id and the total legitimately exceeds `limit` on a
    // populated machine. The wire response carries only the display `project`
    // (project_name/cwd basename), which collapses distinct project_ids, so the
    // exact per-project_id cap isn't reconstructable here — it's owned by the
    // backend worker_history tests. Assert the observable contract: `limit` still
    // bounds the walk (a smaller limit returns no more entries than a larger one).
    const { result: r1 } = renderHook(() => useClaudeHistory(1));
    await waitFor(() => expect(r1.current.isLoading).toBe(false), { timeout: 10000 });
    expect(r1.current.entries.length).toBeLessThanOrEqual(entries.length);

    // --- Embedded session (_session) ---
    const withSession = entries.find((e) => e._session != null);
    if (withSession) {
      const s = withSession._session!;
      // message_count is set by fast meta_dict path; assert number-or-undefined
      expect(s.message_count == null || typeof s.message_count === 'number').toBe(true);
      // tools_used and input_tokens require full JSONL parse — may be absent
      expect(s.tools_used == null || Array.isArray(s.tools_used)).toBe(true);
      expect(s.input_tokens == null || typeof s.input_tokens === 'number').toBe(true);
    }

    // --- session_ref ---
    const withRef = entries.find((e) => e.session_ref != null);
    if (withRef) {
      expect(withRef.session_ref!.id).toBeTruthy();
      expect(['claude_session', 'codex_session', 'copilot_session']).toContain(withRef.session_ref!.type);
    }
  }, 15000);

  it('should refetch and return stable data', async () => {
    expect(dataContext.computeNode).toBeTruthy();

    const { result } = renderHook(() => useClaudeHistory(2));

    await waitFor(
      () => expect(result.current.isLoading).toBe(false),
      { timeout: 10000 },
    );

    const countBefore = result.current.entries.length;

    // Refetch should not throw
    await result.current.refetch();

    await waitFor(
      () => expect(result.current.isLoading).toBe(false),
      { timeout: 10000 },
    );

    // Same count — data hasn't changed between fetches
    expect(result.current.entries.length).toBe(countBefore);
  }, 15000);
});
